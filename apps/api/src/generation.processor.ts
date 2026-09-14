import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { FormData as UndiciFormData } from 'undici';
import { CryptoService } from './crypto.service';
import { PrismaService } from './prisma.service';
import { StorageService } from './storage.service';
import { safeErrorMessage } from './common';
import { fileToDataUrl } from './image-data-url';
import { QWEN_GENERATION_PATH, qwenImageApiRoot, qwenImageFailure, qwenImageRequestBody } from './qwen-image';
import { bananaApiRoot, bananaHeaders, bananaImageFailure, bananaRequestBody } from './nano-banana';
import { seedreamApiRoot, seedreamFailure, seedreamRequestBody } from './seedream';
import { fluxEndpointSlug, fluxRequestBody, pollFluxUntilReady, submitFluxRequest } from './flux';
import { mjPrompt, mjRequestBody, pollMidjourneyTask, submitMidjourneyImagine } from './midjourney';
import { pollRunwayImageTask, runwayImageRequestBody, submitRunwayImage } from './runway-image';
import { IMAGE_LOCK_DURATION_MS, MAX_IMAGE_BYTES } from './domain-constants';
import { MAX_ERROR_BYTES, MAX_GENERATION_RESPONSE_BYTES, SafeHttpService } from './safe-http.service';
import { securityConfig } from './security-config';
import { mapProviderRequestError, providerErrorCode, providerProtocolError as sharedProviderProtocolError, type VideoAdapterDeps } from './provider-adapter';
import { AssetLifecycleService } from './asset-lifecycle.service';
import { providerRequestHeaders } from './provider-credentials';
import { GenerationLifecycleService } from './generation-lifecycle.service';
import { accessibleSourceWhere } from './asset-access';
import type { AuthUser } from './common';
import { providerPromptFor, stylePresetFromParameters } from './style-presets';

type ProviderImageSource = { path?: string; url?: string };
type StreamJsonModule = typeof import('stream-json');

const importStreamJson = new Function('return import("stream-json")') as () => Promise<StreamJsonModule>;
let streamJsonModule: Promise<StreamJsonModule> | undefined;

async function streamJsonParser() {
  streamJsonModule ??= importStreamJson();
  return (await streamJsonModule).parser;
}

export function normalizeImageQuality(modelId: string, quality: unknown) {
  const value = typeof quality === 'string' ? quality : 'auto';
  return /(^|\/)gpt-image-/i.test(modelId) && value === 'standard' ? 'auto' : value;
}

export function providerImageParameters(modelId: string, prompt: string, parameters: { size: unknown; quality: unknown; count: unknown }) {
  return {
    model: modelId,
    prompt,
    size: parameters.size,
    quality: normalizeImageQuality(modelId, parameters.quality),
    n: parameters.count,
  };
}

export function providerEditImageField(count: number) {
  return count > 1 ? 'image[]' : 'image';
}

export function chatImageCompletionBody(modelId: string, prompt: string, imageDataUrls: string[] = []) {
  return {
    model: modelId,
    stream: true,
    messages: [{
      role: 'user',
      content: imageDataUrls.length
        ? [{ type: 'text', text: prompt }, ...imageDataUrls.map((url) => ({ type: 'image_url', image_url: { url } }))]
        : prompt,
    }],
  };
}

export function providerPromptFromJob(job: { mode: string; prompt: string; parameters: unknown }) {
  return providerPromptFor(job.mode, job.prompt, stylePresetFromParameters(job.parameters));
}

export function providerErrorFingerprint(body?: Buffer) {
  return body?.length ? createHash('sha256').update(body).digest('base64url').slice(0, 16) : 'empty';
}

export { providerErrorCode };

export function providerHttpFailure(status: number, body?: Buffer) {
  const providerCode = providerErrorCode(body);
  if (providerCode === 'moderation_blocked') return { code: 'PROVIDER_MODERATION', message: '请求或生成结果被供应商安全检查拒绝，请调整提示词或参考图后重试' };
  if (providerCode === 'text_conversation_not_supported') {
    return { code: 'PROVIDER_PARAMETERS', message: '供应商拒绝了图片请求（错误代码：text_conversation_not_supported）。该模型不接受普通对话，请管理员确认网关中的模型类型为绘图/image，并检查模型 ID、原图、遮罩、尺寸、质量和生成数量' };
  }
  if (status === 400 || status === 422) {
    const detail = providerCode ? `（错误代码：${providerCode}）` : '';
    return { code: 'PROVIDER_PARAMETERS', message: `供应商拒绝了图片或模型参数${detail}，请管理员检查模型能力、原图、遮罩、尺寸、质量和生成数量` };
  }
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH', message: '供应商认证失败，请管理员检查 API Key 和请求头' };
  if (status === 404) return { code: 'PROVIDER_NOT_FOUND', message: '供应商接口或模型不存在，请管理员检查 Base URL 和模型 ID' };
  if (status === 429) return { code: 'PROVIDER_LIMIT', message: '供应商限流或账户额度不足，请稍后重试' };
  return { code: 'PROVIDER_UNAVAILABLE', message: '供应商服务暂时不可用，请稍后重试' };
}

function providerProtocolError(message: string) {
  return sharedProviderProtocolError(message, { code: 'PROVIDER_RESPONSE', message: '供应商响应格式无效，请管理员检查 Base URL 是否包含正确的 /v1' });
}

function rejectProvider(message: string): never {
  const error: any = new Error(message);
  error.noRetry = true;
  error.providerFailure = { code: 'PROVIDER_PARAMETERS', message };
  throw error;
}

function sourceAssetIds(params: { sourceAssetIds?: unknown }) {
  return Array.isArray(params.sourceAssetIds) ? params.sourceAssetIds.filter((id): id is string => typeof id === 'string') : [];
}

function addChatImageRef(value: string, refs: string[], seen: Set<string>) {
  const trimmed = value.trim();
  if (!trimmed || seen.has(trimmed) || refs.length >= 8) return;
  if (trimmed.startsWith('data:image/')) {
    seen.add(trimmed);
    refs.push(trimmed);
    return;
  }
  if (/^https?:\/\//i.test(trimmed) && trimmed.length <= 2048) {
    seen.add(trimmed);
    refs.push(trimmed);
  }
}

function extractChatImageRefsFromText(text: string, refs: string[], seen: Set<string>) {
  const markdown = /!\[[^\]]{0,256}]\((data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^)\s]{1,2048})\)/gi;
  for (const match of text.matchAll(markdown)) addChatImageRef(match[1], refs, seen);
  const dataUrls = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
  for (const match of text.matchAll(dataUrls)) addChatImageRef(match[0], refs, seen);
}

export function extractChatImageRefs(payload: unknown, extraText = ''): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 10 || refs.length >= 8) return;
    if (typeof value === 'string') {
      extractChatImageRefsFromText(value, refs, seen);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.b64_json === 'string') addChatImageRef(`data:image/png;base64,${obj.b64_json.replace(/\s/g, '')}`, refs, seen);
    if (typeof obj.url === 'string') addChatImageRef(obj.url, refs, seen);
    if (typeof obj.image_url === 'string') addChatImageRef(obj.image_url, refs, seen);
    if (typeof obj.image === 'string') addChatImageRef(obj.image, refs, seen);
    const inline = obj.inlineData && typeof obj.inlineData === 'object' && !Array.isArray(obj.inlineData)
      ? obj.inlineData as Record<string, unknown>
      : obj.inline_data && typeof obj.inline_data === 'object' && !Array.isArray(obj.inline_data)
        ? obj.inline_data as Record<string, unknown>
        : undefined;
    if (inline && typeof inline.data === 'string') {
      const mime = typeof inline.mimeType === 'string' ? inline.mimeType : typeof inline.mime_type === 'string' ? inline.mime_type : 'image/png';
      addChatImageRef(`data:${mime};base64,${inline.data.replace(/\s/g, '')}`, refs, seen);
    }
    if ((obj.type === 'image' || obj.type === 'output_image') && typeof obj.data === 'string' && !obj.data.startsWith('data:') && !/^https?:\/\//i.test(obj.data)) {
      const mime = typeof obj.mimeType === 'string' ? obj.mimeType : typeof obj.mime_type === 'string' ? obj.mime_type : 'image/png';
      addChatImageRef(`data:${mime};base64,${obj.data.replace(/\s/g, '')}`, refs, seen);
    }
    for (const nested of [obj.image_url, obj.message, obj.delta, obj.content, obj.images, obj.data, obj.choices, obj.output, obj.candidates, obj.parts, obj.steps]) {
      if (nested !== undefined) visit(nested, depth + 1);
    }
  };
  visit(payload, 0);
  extractChatImageRefsFromText(extraText, refs, seen);
  return refs;
}

async function materializeChatImageRef(ref: string, storage: StorageService): Promise<ProviderImageSource> {
  if (/^https?:\/\//i.test(ref)) {
    if (ref.length > 2048) throw providerProtocolError('供应商图片地址过长');
    return { url: ref };
  }
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(ref);
  if (!match) throw providerProtocolError('供应商返回了无效的内嵌图片');
  const encoded = match[2].replace(/\s/g, '');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if ((encoded.length * 3) / 4 - padding > MAX_IMAGE_BYTES) throw providerProtocolError('供应商图片超过大小限制');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) throw providerProtocolError('供应商返回了空的 Base64 图片');
  if (bytes.length > MAX_IMAGE_BYTES) throw providerProtocolError('供应商图片超过大小限制');
  const path = await storage.createStagingPath('.image');
  const writer = createWriteStream(path, { flags: 'wx' });
  try {
    if (!writer.write(bytes)) await once(writer, 'drain');
    writer.end();
    await finished(writer);
    return { path };
  } catch (error) {
    writer.destroy();
    await storage.deleteStaged(path).catch(() => undefined);
    throw error;
  }
}

async function peekFileText(path: string, length = 64) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function parseChatCompletionImages(jsonPath: string, count: number, storage: StorageService): Promise<ProviderImageSource[]> {
  const peek = (await peekFileText(jsonPath)).trimStart();
  const refs: string[] = [];
  const seen = new Set<string>();
  if (peek.startsWith('data:') || peek.startsWith('event:')) {
    const lines = createInterface({ input: createReadStream(jsonPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { extractChatImageRefs(JSON.parse(data)).forEach((ref) => addChatImageRef(ref, refs, seen)); }
        catch { extractChatImageRefsFromText(data, refs, seen); }
        if (refs.length >= count) break;
      }
    } finally {
      lines.close();
    }
  } else {
    const body = await readFile(jsonPath, 'utf8');
    try { extractChatImageRefs(JSON.parse(body)).forEach((ref) => addChatImageRef(ref, refs, seen)); }
    catch { extractChatImageRefsFromText(body, refs, seen); }
  }
  const selected = refs.slice(0, Math.max(1, count));
  if (!selected.length) throw providerProtocolError('供应商未返回图片数据');
  const staged: string[] = [];
  try {
    const images = [];
    for (const ref of selected) {
      const image = await materializeChatImageRef(ref, storage);
      if (image.path) staged.push(image.path);
      images.push(image);
    }
    staged.length = 0;
    return images;
  } finally {
    await Promise.all(staged.map((path) => storage.deleteStaged(path).catch(() => undefined)));
  }
}

export async function parseProviderImages(jsonPath: string, count: number, storage: StorageService): Promise<ProviderImageSource[]> {
  const parser = await streamJsonParser();
  const tokens = parser.asStream({ packKeys: true, streamKeys: false, packStrings: false, streamStrings: true, packNumbers: true, streamNumbers: false });
  const input = createReadStream(jsonPath);
  input.on('error', (error) => tokens.destroy(error));
  input.pipe(tokens);
  const images: ProviderImageSource[] = [];
  const staged = new Set<string>();
  let depth = 0;
  let awaitingDataArray = false;
  let dataArrayDepth = 0;
  let itemDepth = 0;
  let itemIndex = 0;
  let currentKey = '';
  let current: (ProviderImageSource & { wanted: boolean }) | undefined;
  let stringKind: 'b64_json' | 'url' | undefined;
  let urlValue = '';
  let base64Path = '';
  let base64Carry = '';
  let decodedBytes = 0;
  let writer: ReturnType<typeof createWriteStream> | undefined;
  let writerDone: Promise<void> | undefined;
  let writerFailure: unknown;

  const writeBase64 = async (value: string, final = false) => {
    if (!/^[A-Za-z0-9+/=]*$/.test(value)) throw providerProtocolError('供应商返回了无效的 Base64 图片');
    const combined = base64Carry + value;
    const paddingAt = combined.indexOf('=');
    if (paddingAt !== -1 && /[^=]/.test(combined.slice(paddingAt))) throw providerProtocolError('供应商返回了无效的 Base64 填充');
    if (paddingAt !== -1 && combined.length - paddingAt > 2) throw providerProtocolError('供应商返回了无效的 Base64 填充');
    let length = final ? combined.length : Math.max(0, combined.length - 4);
    if (!final && paddingAt !== -1) length = Math.min(length, paddingAt - (paddingAt % 4));
    if (!final) length -= length % 4;
    if (final && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(combined)) throw providerProtocolError('供应商返回了无效的 Base64 图片');
    const encoded = combined.slice(0, length);
    base64Carry = combined.slice(length);
    if (!encoded) return;
    const decoded = Buffer.from(encoded, 'base64');
    decodedBytes += decoded.length;
    if (decodedBytes > MAX_IMAGE_BYTES) throw providerProtocolError('供应商图片超过大小限制');
    if (writer && !writer.write(decoded)) await once(writer, 'drain');
  };

  const closeWriter = async () => {
    if (!writer) return;
    if (!decodedBytes) throw providerProtocolError('供应商返回了空的 Base64 图片');
    writer.end();
    await writerDone;
    if (writerFailure) throw writerFailure;
    writer = undefined;
    writerDone = undefined;
  };

  try {
    for await (const rawToken of tokens as any) {
      const token = rawToken as { name: string; value?: string };
      if (awaitingDataArray && token.name !== 'startArray' && token.name !== 'keyValue') awaitingDataArray = false;
      if (token.name === 'keyValue') {
        if (depth === 1 && token.value === 'data') awaitingDataArray = true;
        else if (itemDepth && depth === itemDepth) currentKey = token.value ?? '';
        continue;
      }
      if (token.name === 'startArray') {
        depth += 1;
        if (awaitingDataArray && depth === 2) dataArrayDepth = depth;
        awaitingDataArray = false;
        continue;
      }
      if (token.name === 'endArray') {
        if (depth === dataArrayDepth) dataArrayDepth = 0;
        depth -= 1;
        currentKey = '';
        continue;
      }
      if (token.name === 'startObject') {
        depth += 1;
        if (dataArrayDepth && depth === dataArrayDepth + 1) {
          itemDepth = depth;
          itemIndex += 1;
          current = { wanted: itemIndex <= count };
        }
        awaitingDataArray = false;
        continue;
      }
      if (token.name === 'endObject') {
        if (itemDepth && depth === itemDepth) {
          if (current?.wanted) {
            if (!current.path && !current.url) throw providerProtocolError('供应商图片条目缺少 b64_json 或 url');
            images.push({ path: current.path, url: current.path ? undefined : current.url });
          }
          current = undefined;
          itemDepth = 0;
        }
        depth -= 1;
        currentKey = '';
        continue;
      }
      if (token.name === 'startString' && current && depth === itemDepth && (currentKey === 'b64_json' || currentKey === 'url')) {
        stringKind = currentKey;
        if (stringKind === 'url') urlValue = '';
        else if (current.wanted) {
          base64Path = await storage.createStagingPath('.image');
          staged.add(base64Path);
          base64Carry = '';
          decodedBytes = 0;
          writer = createWriteStream(base64Path, { flags: 'wx' });
          writerFailure = undefined;
          writerDone = finished(writer).catch((error) => { writerFailure = error; });
        }
        continue;
      }
      if (token.name === 'stringChunk' && stringKind && current) {
        if (stringKind === 'url') {
          if (current.wanted) {
            urlValue += token.value ?? '';
            if (urlValue.length > 2048) throw providerProtocolError('供应商图片地址过长');
          }
        } else if (current.wanted) await writeBase64(token.value ?? '');
        continue;
      }
      if (token.name === 'endString' && stringKind && current) {
        if (stringKind === 'url' && current.wanted) current.url = urlValue;
        else if (stringKind === 'b64_json' && current.wanted) {
          await writeBase64('', true);
          await closeWriter();
          current.path = base64Path;
        }
        stringKind = undefined;
        currentKey = '';
      }
    }
    if (!images.length) throw providerProtocolError('供应商未返回图片数据');
    for (const image of images) if (image.path) staged.delete(image.path);
    return images;
  } catch (error) {
    if (writer) { writer.destroy(); await writerDone; }
    throw error instanceof Error && (error as any).providerFailure ? error : providerProtocolError('供应商返回的 JSON 无法解析');
  } finally {
    await Promise.all([...staged].map((path) => storage.deleteStaged(path).catch(() => undefined)));
  }
}

@Processor('image-generation', {
  concurrency: securityConfig.workerConcurrency(),
  lockDuration: IMAGE_LOCK_DURATION_MS,
  stalledInterval: 60_000,
})
export class GenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(GenerationProcessor.name);
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private storage: StorageService,
    private http: SafeHttpService,
    private assets: AssetLifecycleService,
    private lifecycle: GenerationLifecycleService,
  ) { super(); }

  async process(queueJob: Job<{ jobId: string }>) {
    const job = await this.prisma.generationJob.findUnique({
      where: { id: queueJob.data.jobId },
      select: {
        id: true,
        userId: true,
        mode: true,
        prompt: true,
        parameters: true,
        status: true,
        user: { select: { status: true, role: true } },
        model: {
          select: {
            adapterKind: true,
            upstreamModelId: true,
            provider: { select: { baseUrl: true, encryptedApiKey: true, encryptedHeaders: true, timeoutSeconds: true, pollTimeoutSeconds: true } },
          },
        },
      },
    });
    if (!job) return;
    if (job.status === 'CANCELLED' || job.user.status !== 'ACTIVE') { await this.lifecycle.releaseAndPublish(job.userId, job.id); return; }
    if (!job.model) {
      await this.lifecycle.finish(job.userId, job.id, 'FAILED', { code: 'MODEL_DELETED', message: '模型已被删除' });
      return;
    }
    if (!await this.lifecycle.start(job.userId, job.id)) {
      await this.lifecycle.releaseAndPublish(job.userId, job.id);
      return;
    }
    try {
      const params = job.parameters as any;
      const providerPrompt = providerPromptFromJob(job);
      const provider = job.model.provider;
      const headers = providerRequestHeaders(this.crypto, provider);
      const isQwenImage = job.model.adapterKind === 'qwen-image';
      const isNanoBanana = job.model.adapterKind === 'nano-banana';
      const isSeedream = job.model.adapterKind === 'seedream';
      const isFlux = job.model.adapterKind === 'flux';
      const isMidjourney = job.model.adapterKind === 'midjourney';
      const isRunwayImages = job.model.adapterKind === 'runway-images';
      if (isFlux || isMidjourney || isRunwayImages) {
        const persisted = await this.runAsyncImageAdapter({
          id: job.id,
          userId: job.userId,
          mode: job.mode,
          prompt: providerPrompt,
          user: job.user,
          model: job.model,
        }, params, headers, isFlux ? 'flux' : isMidjourney ? 'midjourney' : 'runway-images');
        if (!persisted) return;
        const completed = await this.lifecycle.finish(job.userId, job.id, 'SUCCEEDED');
        if (!completed) await this.assets.removeJobOutputs(job.userId, job.id);
        if (params.maskAssetId) {
          try { await this.assets.removeMask(job.userId, params.maskAssetId); }
          catch (error) { this.logger.warn(`任务 ${job.id} 已成功，但遮罩清理失败：${safeErrorMessage(error)}`); }
        }
        return;
      }
      const requestStaged: string[] = [];
      let requestUrl: string;
      let body: BodyInit | UndiciFormData;
      if (isNanoBanana) {
        Object.assign(headers, bananaHeaders(headers, { 'Content-Type': 'application/json' }));
        requestUrl = `${bananaApiRoot(provider.baseUrl)}/models/${job.model.upstreamModelId}:generateContent`;
        const sourceIds = sourceAssetIds(params);
        if (job.mode === 'INPAINT') rejectProvider('Nano Banana 不支持蒙版局部重绘，请改用参考图编辑');
        if (sourceIds.length > 14) rejectProvider('Nano Banana 最多支持 14 张参考图，请减少参考图数量');
        const reader = await this.jobReader(job.userId, job.user.role);
        const images: Array<{ mimeType: string; data: string }> = [];
        for (const assetId of sourceIds) {
          const asset = await this.sourceAsset(reader, assetId);
          const mime = asset.mimeType === 'image/jpeg' || asset.mimeType === 'image/webp' ? asset.mimeType : 'image/png';
          images.push({ mimeType: mime, data: (await readFile(this.storage.filePath(asset.objectKey))).toString('base64') });
        }
        body = JSON.stringify(bananaRequestBody(providerPrompt, params, images));
      } else if (isSeedream) {
        requestUrl = `${seedreamApiRoot(provider.baseUrl)}/images/generations`;
        headers['Content-Type'] = 'application/json';
        const sourceIds = sourceAssetIds(params);
        if (job.mode === 'INPAINT') rejectProvider('Seedream 不支持蒙版局部重绘，请改用参考图编辑');
        if (sourceIds.length > 14) rejectProvider('Seedream 最多支持 14 张参考图，请减少参考图数量');
        const reader = await this.jobReader(job.userId, job.user.role);
        const imageDataUrls: string[] = [];
        for (const assetId of sourceIds) {
          const asset = await this.sourceAsset(reader, assetId);
          imageDataUrls.push(await fileToDataUrl(this.storage.filePath(asset.objectKey), asset.mimeType));
        }
        body = JSON.stringify(seedreamRequestBody(job.model.upstreamModelId, providerPrompt, params, imageDataUrls));
      } else if (isQwenImage) {
        requestUrl = `${qwenImageApiRoot(provider.baseUrl)}${QWEN_GENERATION_PATH}`;
        headers['Content-Type'] = 'application/json';
        const sourceIds = sourceAssetIds(params);
        if (job.mode === 'INPAINT') rejectProvider('Qwen/Wan 不支持蒙版局部重绘，请改用参考图编辑');
        if (sourceIds.length > 3) rejectProvider('Qwen/Wan 最多支持 3 张参考图，请减少参考图数量');
        const reader = await this.jobReader(job.userId, job.user.role);
        const imageDataUrls: string[] = [];
        for (const assetId of sourceIds) {
          const asset = await this.sourceAsset(reader, assetId);
          imageDataUrls.push(await fileToDataUrl(this.storage.filePath(asset.objectKey), asset.mimeType));
        }
        body = JSON.stringify(qwenImageRequestBody(job.model.upstreamModelId, providerPrompt, params, imageDataUrls));
      } else if (job.mode === 'TEXT_TO_IMAGE') {
        requestUrl = `${provider.baseUrl}/images/generations`;
        const requestParameters = providerImageParameters(job.model.upstreamModelId, providerPrompt, params);
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(requestParameters);
      } else {
        requestUrl = `${provider.baseUrl}/images/edits`;
        const requestParameters = providerImageParameters(job.model.upstreamModelId, providerPrompt, params);
        const form = new UndiciFormData();
        for (const [key, value] of Object.entries(requestParameters)) form.set(key, String(value));
        const sourceIds = sourceAssetIds(params);
        const imageField = providerEditImageField(sourceIds.length);
        const reader = await this.jobReader(job.userId, job.user.role);
        let firstSource: Awaited<ReturnType<GenerationProcessor['sourceAsset']>> | undefined;
        for (const assetId of sourceIds) {
          const asset = await this.sourceAsset(reader, assetId);
          firstSource ??= asset;
          form.append(imageField, await openAsBlob(this.storage.filePath(asset.objectKey), { type: asset.mimeType }), asset.originalName ?? 'image.png');
        }
        if (params.maskAssetId) {
          const mask = await this.ownedMask(job.userId, params.maskAssetId);
          let maskPath = this.storage.filePath(mask.objectKey);
          let maskType = mask.mimeType;
          if (firstSource?.width && firstSource.height && (mask.width !== firstSource.width || mask.height !== firstSource.height)) {
            maskPath = await this.storage.resizeMaskFile(mask.objectKey, firstSource.width, firstSource.height);
            maskType = 'image/png';
            requestStaged.push(maskPath);
          }
          form.set('mask', await openAsBlob(maskPath, { type: maskType }), 'mask.png');
        }
        body = form;
      }

      let responsePath = await this.storage.createStagingPath('.json');
      let response;
      let usedChatFallback = false;
      try {
        try {
          response = await this.http.requestToFile(requestUrl, { method: 'POST', headers, body: body as any, redirectPolicy: 'same-origin', signal: AbortSignal.timeout(provider.timeoutSeconds * 1000) }, responsePath, MAX_GENERATION_RESPONSE_BYTES, MAX_ERROR_BYTES);
        } catch (cause) {
          const error: any = new Error('供应商连接失败、响应过大或请求超时', { cause });
          error.providerConnection = true;
          throw error;
        }
      } finally {
        await Promise.all(requestStaged.map((path) => this.storage.deleteStaged(path).catch(() => undefined)));
      }
      try {
        if (!response.ok && !isQwenImage && !isNanoBanana && !isSeedream && providerErrorCode(response.body) === 'text_conversation_not_supported') {
          const fallback = await this.tryChatImageFallback({ id: job.id, userId: job.userId, prompt: providerPrompt, user: job.user, model: job.model }, params, headers, responsePath);
          if (fallback) {
            responsePath = fallback.responsePath;
            response = fallback.response;
            usedChatFallback = true;
          }
        }
        if (!response.ok) {
          const fingerprint = providerErrorFingerprint(response.body);
          const providerCode = providerErrorCode(response.body);
          this.logger.warn(`供应商拒绝任务 ${job.id}：HTTP ${response.status}，providerCode=${providerCode ?? 'unknown'}，responseBytes=${response.body?.length ?? 0}，fingerprint=${fingerprint}`);
          const error: any = new Error(`供应商返回 ${response.status}`);
          error.noRetry = response.status >= 400 && response.status < 500;
          error.providerFailure = isSeedream ? seedreamFailure(response.status, response.body) : isNanoBanana ? bananaImageFailure(response.status, response.body) : isQwenImage ? qwenImageFailure(response.status, response.body) : providerHttpFailure(response.status, response.body);
          throw error;
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.filePath) throw providerProtocolError(`供应商返回类型无效：${contentType || 'missing'}`);
        if (!usedChatFallback && !contentType.includes('application/json')) throw providerProtocolError(`供应商返回类型无效：${contentType || 'missing'}`);
        if (usedChatFallback && contentType && !/json|event-stream|text\/plain/i.test(contentType)) throw providerProtocolError(`供应商返回类型无效：${contentType}`);
        const sources = usedChatFallback || isQwenImage || isNanoBanana
          ? await parseChatCompletionImages(response.filePath, params.count, this.storage)
          : await parseProviderImages(response.filePath, params.count, this.storage);
        try {
          const [freshUser, freshJob] = await Promise.all([
            this.prisma.user.findUnique({ where: { id: job.userId }, select: { status: true } }),
            this.prisma.generationJob.findUnique({ where: { id: job.id }, select: { status: true } }),
          ]);
          if (!freshUser || freshUser.status !== 'ACTIVE' || !freshJob || freshJob.status === 'CANCELLED') {
            await this.lifecycle.finish(job.userId, job.id, 'CANCELLED');
            return;
          }
          for (const source of sources) await this.persistSource(job.userId, job.id, source);
        } finally {
          await Promise.all(sources.map((source) => source.path ? this.storage.deleteStaged(source.path).catch(() => undefined) : Promise.resolve()));
        }
      } finally {
        await this.storage.deleteStaged(responsePath).catch(() => undefined);
      }

      const completed = await this.lifecycle.finish(job.userId, job.id, 'SUCCEEDED');
      if (!completed) await this.assets.removeJobOutputs(job.userId, job.id);
      if (params.maskAssetId) {
        try { await this.assets.removeMask(job.userId, params.maskAssetId); }
        catch (error) { this.logger.warn(`任务 ${job.id} 已成功，但遮罩清理失败：${safeErrorMessage(error)}`); }
      }
    } catch (error: any) {
      const finalAttempt = error?.noRetry || queueJob.attemptsMade + 1 >= (queueJob.opts.attempts ?? 1);
      this.logger.warn(`任务 ${job.id} 失败：${safeErrorMessage(error)}`);
      if (finalAttempt) {
        const failure = error?.providerFailure ?? (error?.providerConnection ? { code: 'PROVIDER_CONNECTION', message: '无法连接供应商、响应过大或请求超时，请管理员检查网络、超时和响应限制' } : { code: 'GENERATION_FAILED', message: '图片生成失败' });
        await this.lifecycle.finish(job.userId, job.id, 'FAILED', failure);
      }
      if (error?.noRetry) throw new UnrecoverableError(safeErrorMessage(error));
      throw error;
    }
  }

  private async tryChatImageFallback(
    job: { id: string; userId: string; prompt: string; user: { role: 'USER' | 'ADMIN' }; model: { upstreamModelId: string; provider: { baseUrl: string; timeoutSeconds: number } } },
    params: { sourceAssetIds?: unknown; maskAssetId?: unknown; count?: unknown },
    headers: Record<string, string>,
    failedPath: string,
  ) {
    const chatPath = await this.storage.createStagingPath('.chat');
    try {
      const imageDataUrls: string[] = [];
      const sourceIds = sourceAssetIds(params);
      if (sourceIds.length || typeof params.maskAssetId === 'string') {
        const reader = await this.jobReader(job.userId, job.user.role);
        for (const assetId of sourceIds) {
          const asset = await this.sourceAsset(reader, assetId);
          imageDataUrls.push(await fileToDataUrl(this.storage.filePath(asset.objectKey), asset.mimeType));
        }
        if (typeof params.maskAssetId === 'string') {
          const mask = await this.ownedMask(job.userId, params.maskAssetId);
          imageDataUrls.push(await fileToDataUrl(this.storage.filePath(mask.objectKey), mask.mimeType));
        }
      }
      const chatHeaders = { ...headers, 'Content-Type': 'application/json' };
      const response = await this.http.requestToFile(
        `${job.model.provider.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: chatHeaders,
          body: JSON.stringify(chatImageCompletionBody(job.model.upstreamModelId, job.prompt, imageDataUrls)),
          redirectPolicy: 'same-origin',
          signal: AbortSignal.timeout(job.model.provider.timeoutSeconds * 1000),
        },
        chatPath,
        MAX_GENERATION_RESPONSE_BYTES,
        MAX_ERROR_BYTES,
      );
      if (!response.ok) {
        await this.storage.deleteStaged(chatPath).catch(() => undefined);
        return undefined;
      }
      await this.storage.deleteStaged(failedPath).catch(() => undefined);
      this.logger.warn(`任务 ${job.id} 的 Images 接口返回 text_conversation_not_supported，已改走 Chat Completions`);
      return { response, responsePath: chatPath };
    } catch (error) {
      await this.storage.deleteStaged(chatPath).catch(() => undefined);
      this.logger.warn(`任务 ${job.id} 的 Chat Completions 回退失败：${safeErrorMessage(error)}`);
      return undefined;
    }
  }

  private async runAsyncImageAdapter(
    job: {
      id: string;
      userId: string;
      mode: string;
      prompt: string;
      user: { role: 'USER' | 'ADMIN' };
      model: {
        upstreamModelId: string;
        provider: { baseUrl: string; timeoutSeconds: number; pollTimeoutSeconds: number };
      };
    },
    params: Record<string, unknown>,
    headers: Record<string, string>,
    kind: 'flux' | 'midjourney' | 'runway-images',
  ): Promise<boolean> {
    const label = kind === 'flux' ? 'Flux' : kind === 'midjourney' ? 'Midjourney' : 'Runway';
    if (job.mode === 'INPAINT') rejectProvider(`${label} 不支持蒙版局部重绘，请改用参考图编辑`);
    const sourceIds = sourceAssetIds(params);
    const maxRefs = kind === 'flux' ? 8 : kind === 'midjourney' ? 5 : 3;
    if (sourceIds.length > maxRefs) rejectProvider(`${label} 最多支持 ${maxRefs} 张参考图，请减少参考图数量`);
    const deps: VideoAdapterDeps = {
      http: this.http,
      headers,
      baseUrl: job.model.provider.baseUrl,
      timeoutSeconds: job.model.provider.timeoutSeconds,
      pollTimeoutSeconds: job.model.provider.pollTimeoutSeconds,
    };
    try {
      let token = typeof params.providerTaskId === 'string' && params.providerTaskId.trim() ? params.providerTaskId.trim() : '';
      if (!token) {
        const reader = await this.jobReader(job.userId, job.user.role);
        const images: string[] = [];
        for (const assetId of sourceIds) {
          const asset = await this.sourceAsset(reader, assetId);
          if (kind === 'flux') images.push((await readFile(this.storage.filePath(asset.objectKey))).toString('base64'));
          else images.push(await fileToDataUrl(this.storage.filePath(asset.objectKey), asset.mimeType));
        }
        token = kind === 'flux'
          ? await submitFluxRequest(deps, fluxEndpointSlug(job.model.upstreamModelId), fluxRequestBody(job.prompt, params, images))
          : kind === 'midjourney'
            ? await submitMidjourneyImagine(deps, mjRequestBody(mjPrompt(job.prompt, job.model.upstreamModelId, params), images))
            : await submitRunwayImage(deps, runwayImageRequestBody(job.model.upstreamModelId, job.prompt, params, images));
        await this.prisma.generationJob.update({ where: { id: job.id }, data: { parameters: { ...params, providerTaskId: token } as object } });
      }
      const imageUrl = kind === 'flux'
        ? await pollFluxUntilReady(deps, token)
        : kind === 'midjourney'
          ? await pollMidjourneyTask(deps, token)
          : await pollRunwayImageTask(deps, token);
      const [freshUser, freshJob] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: job.userId }, select: { status: true } }),
        this.prisma.generationJob.findUnique({ where: { id: job.id }, select: { status: true } }),
      ]);
      if (!freshUser || freshUser.status !== 'ACTIVE' || !freshJob || freshJob.status === 'CANCELLED') {
        await this.lifecycle.finish(job.userId, job.id, 'CANCELLED');
        return false;
      }
      await this.persistSource(job.userId, job.id, { url: imageUrl });
      return true;
    } catch (error: any) {
      throw mapProviderRequestError(error);
    }
  }

  private async persistSource(userId: string, jobId: string, source: ProviderImageSource) {
    const rawPath = source.path ?? await this.download(source.url);
    try {
      const image = await this.storage.inspectImageWithThumbnail(rawPath);
      await this.assets.persistNormalized({ userId, jobId, role: 'OUTPUT', image });
    } catch (error) {
      await this.storage.deleteStaged(rawPath).catch(() => undefined);
      throw error;
    }
  }

  private async jobReader(userId: string, role: AuthUser['role']): Promise<Pick<AuthUser, 'id' | 'role' | 'teamIds'>> {
    if (role === 'ADMIN') return { id: userId, role, teamIds: [] };
    const rows = await this.prisma.workTeamMembership.findMany({ where: { userId }, select: { teamId: true } });
    return { id: userId, role, teamIds: rows.map(({ teamId }) => teamId) };
  }

  private async sourceAsset(user: Pick<AuthUser, 'id' | 'role' | 'teamIds'>, id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id, ...accessibleSourceWhere(user as AuthUser) },
      select: { objectKey: true, mimeType: true, originalName: true, width: true, height: true },
    });
    if (!asset) throw new Error('引用图片不存在');
    return asset;
  }

  private async ownedMask(userId: string, id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id, userId, deletedAt: null, role: 'MASK' },
      select: { objectKey: true, mimeType: true, originalName: true, width: true, height: true },
    });
    if (!asset) throw new Error('引用图片不存在');
    return asset;
  }

  private async download(url: unknown) {
    if (typeof url !== 'string') throw providerProtocolError('供应商图片地址无效');
    const destination = await this.storage.createStagingPath('.download');
    try {
      const response = await this.http.requestToFile(url, { method: 'GET', redirectPolicy: 'any', signal: AbortSignal.timeout(60_000) }, destination, MAX_IMAGE_BYTES, MAX_ERROR_BYTES);
      if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
      const type = response.headers.get('content-type') ?? '';
      if (type && !/^image\//i.test(type) && !/^application\/octet-stream/i.test(type)) throw providerProtocolError('供应商图片类型无效');
      return destination;
    } catch (error) {
      await this.storage.deleteStaged(destination).catch(() => undefined);
      throw error;
    }
  }

}
