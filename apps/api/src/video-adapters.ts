import { writeFile } from 'node:fs/promises';
import { FormData as UndiciFormData } from 'undici';
import { pollDelayMs, MAX_VIDEO_BYTES, isVideoAdapterKind } from './domain-constants';
import { MAX_ERROR_BYTES } from './safe-http.service';
import {
  aspectRatioOf,
  bearerToken,
  durationSecondsOf,
  jsonObject,
  parseJsonBody,
  providerErrorCode,
  providerProtocolError,
  providerTimeoutError,
  resolutionOf,
  sleep as defaultSleep,
  text,
  videoHttpFailure,
  type JsonObject,
  type MediaGenerationAdapter,
  type MediaGenerationRequest,
  type VideoAdapterDeps,
} from './provider-adapter';

type Json = JsonObject;
import {
  fluxApiRoot,
  fluxHeaders,
  fluxPollingUrl,
  fluxTaskId,
  fluxTaskToken,
  fluxVideoAspect,
  fluxVideoPath,
  fluxVideoResolution,
  pollFluxUntilReady,
  testFluxConnection,
} from './flux';

function dataUrl(asset: { mimeType: string; bytes: Uint8Array }) {
  const mime = asset.mimeType === 'image/jpeg' || asset.mimeType === 'image/webp' ? asset.mimeType : 'image/png';
  return `data:${mime};base64,${Buffer.from(asset.bytes).toString('base64')}`;
}

function firstSource(request: MediaGenerationRequest) {
  return request.inputAssets.find((asset) => asset.role === 'SOURCE');
}

function dashscopeError(body?: Buffer) {
  const object = jsonObject(parseJsonBody(body));
  const output = jsonObject(object?.output);
  return {
    code: text(object?.code) ?? text(output?.code) ?? providerErrorCode(body),
    message: text(object?.message) ?? text(output?.message),
  };
}

function throwIfDashScopeFailed(payload: unknown) {
  const object = jsonObject(payload);
  const output = jsonObject(object?.output);
  const code = text(object?.code) ?? text(output?.code);
  const message = text(object?.message) ?? text(output?.message);
  if (!code || /^(null|ok|success)$/i.test(code)) return;
  if (wanTaskId(payload)) return;
  const error: any = new Error(message || code);
  error.noRetry = true;
  error.providerFailure = {
    code: 'PROVIDER_PARAMETERS',
    message: message ? `供应商拒绝了视频或模型参数：${message}` : `供应商拒绝了视频或模型参数（${code}）`,
  };
  throw error;
}

function throwHttp(status: number, body?: Buffer) {
  const dash = dashscopeError(body);
  const error: any = new Error(`供应商返回 ${status}`);
  error.noRetry = status >= 400 && status < 500;
  const failure = videoHttpFailure(status, dash.code);
  if (status === 404) {
    failure.message = dash.message
      ? `供应商接口返回 404：${dash.message}`
      : '供应商接口或模型不存在。Wan 的 Base URL 优先填 https://dashscope.aliyuncs.com/api/v1，不要带 video-synthesis，也不要使用 compatible-mode。文生视频模型 ID 应为 wan2.7-t2v 或 wan2.7-t2v-2026-06-12。';
  } else if (dash.message && (status === 400 || status === 422)) {
    failure.message = `供应商拒绝了视频或模型参数：${dash.message}`;
  }
  error.providerFailure = failure;
  throw error;
}

export function videoHttpTimeoutMs(deps: Pick<VideoAdapterDeps, 'timeoutSeconds'>) {
  return Math.min(Math.max(Number(deps.timeoutSeconds) || 180, 10), 3600) * 1000;
}

export function videoPollTimeoutMs(deps: Pick<VideoAdapterDeps, 'pollTimeoutSeconds'>) {
  return Math.min(Math.max(Number(deps.pollTimeoutSeconds) || 900, 10), 3600) * 1000;
}

export function videoLongTimeoutMs(deps: Pick<VideoAdapterDeps, 'timeoutSeconds' | 'pollTimeoutSeconds'>) {
  return Math.max(videoHttpTimeoutMs(deps), videoPollTimeoutMs(deps), 120_000);
}

function requestHeaders(deps: VideoAdapterDeps, extra?: Record<string, string>) {
  return { ...deps.headers, ...extra };
}

function pickString(source: unknown, keys: string[]): string | undefined {
  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > 6) return undefined;
    const object = jsonObject(value);
    if (!object) return undefined;
    for (const key of keys) {
      const candidate = text(object[key]);
      if (candidate) return candidate;
    }
    for (const nested of Object.values(object)) {
      if (Array.isArray(nested)) {
        for (const item of nested) {
          const found = visit(item, depth + 1);
          if (found) return found;
        }
      } else {
        const found = visit(nested, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(source, 0);
}

export function openaiVideoTaskId(payload: unknown) {
  return text(jsonObject(payload)?.id);
}

export function openaiVideoStatus(payload: unknown) {
  return text(jsonObject(payload)?.status)?.toLowerCase();
}

/** Official Sora sizes are WxH tokens, not named ratios. */
export function openaiVideoSize(size: string, quality?: string) {
  const raw = size.trim();
  const exact = /^(720x1280|1280x720|1024x1792|1792x1024)$/i.test(raw);
  if (exact) return raw.replace(/X/, 'x');
  const landscape = /^(16:9|1280:720|1920:1080)$/i.test(raw);
  const portrait = /^(9:16|720:1280|1080:1920)$/i.test(raw);
  const hi = typeof quality === 'string' && /^(1080p|fhd|2k|high|1792)/i.test(quality.trim());
  if (landscape) return hi ? '1792x1024' : '1280x720';
  if (portrait) return hi ? '1024x1792' : '720x1280';
  const pixels = /^(\d{3,5})[xX×:](\d{3,5})$/.exec(raw);
  if (pixels) return Number(pixels[1]) >= Number(pixels[2]) ? (hi ? '1792x1024' : '1280x720') : (hi ? '1024x1792' : '720x1280');
  return raw;
}

export function seedanceTaskId(payload: unknown) {
  const object = jsonObject(payload);
  return text(object?.id) ?? text(jsonObject(object?.data)?.id);
}

export function seedanceStatus(payload: unknown) {
  return text(jsonObject(payload)?.status)?.toLowerCase();
}

export function seedanceVideoUrl(payload: unknown) {
  return pickString(payload, ['video_url', 'url']);
}

export function wanTaskId(payload: unknown) {
  const object = jsonObject(payload);
  const output = jsonObject(object?.output);
  return text(output?.task_id) ?? text(object?.task_id) ?? text(object?.id);
}

export function wanStatus(payload: unknown) {
  const object = jsonObject(payload);
  const output = jsonObject(object?.output);
  return (text(output?.task_status) ?? text(object?.task_status) ?? text(object?.status))?.toUpperCase();
}

export function wanVideoUrl(payload: unknown) {
  return pickString(payload, ['video_url', 'url']);
}

const WAN_SYNTHESIS_PATH = '/services/aigc/video-generation/video-synthesis';

export function wanApiRoot(baseUrl: string) {
  let url = baseUrl.trim().replace(/\/+$/, '');
  url = url.replace(/\/services\/aigc\/video-generation\/video-synthesis$/i, '');
  url = url.replace(/\/compatible-mode\/v1$/i, '/api/v1');
  if (/^https:\/\/dashscope(?:-intl)?\.aliyuncs\.com$/i.test(url)) url += '/api/v1';
  if (/^https:\/\/[^/]+\.maas\.aliyuncs\.com$/i.test(url)) url += '/api/v1';
  return url.replace(/\/+$/, '');
}

export function wanResolution(value: string) {
  const match = /^(480|720|1080)p$/i.exec(value.trim());
  return match ? `${match[1]}P` : value.trim();
}

export function wanParameters(parameters: Record<string, unknown>) {
  const aspect = aspectRatioOf(parameters);
  const quality = resolutionOf(parameters);
  const result: Json = {
    duration: durationSecondsOf(parameters),
    prompt_extend: false,
    watermark: false,
  };
  if (aspect && /^\d+:\d+$/.test(aspect)) result.ratio = aspect;
  else if (aspect && /\d+[x*×]\d+/i.test(aspect)) result.size = aspect.replace(/[x×]/gi, '*');
  if (quality) {
    const normalized = wanResolution(quality);
    if (/^(480|720|1080)P$/.test(normalized)) result.resolution = normalized;
    else if (/\d+[x*×]\d+/i.test(quality)) result.size = quality.replace(/[x×]/gi, '*');
    else result.resolution = normalized;
  }
  return result;
}

export function wanInput(request: MediaGenerationRequest) {
  const sources = request.inputAssets.filter((asset) => asset.role === 'SOURCE');
  const input: Json = { prompt: request.prompt };
  if (!sources.length) return input;
  if (/wan2\.7|wan3/i.test(request.upstreamModelId)) {
    const media: Json[] = [{ type: 'first_frame', url: dataUrl(sources[0]) }];
    if (sources[1]) media.push({ type: 'last_frame', url: dataUrl(sources[1]) });
    input.media = media;
  } else {
    input.img_url = dataUrl(sources[0]);
  }
  return input;
}

export function veoApiRoot(baseUrl: string) {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (/^https:\/\/generativelanguage\.googleapis\.com$/i.test(url)) url += '/v1beta';
  return url.replace(/\/+$/, '');
}

export function veoOperationUrl(root: string, taskId: string) {
  const name = taskId.trim().replace(/^\//, '');
  if (/^https?:\/\//i.test(name)) return name;
  if (/^(operations|models)\//i.test(name)) return `${root}/${name}`;
  return `${root}/operations/${name}`;
}

export function veoResolution(value: string) {
  const trimmed = value.trim();
  if (/^4k$/i.test(trimmed)) return '4k';
  const match = /^(720|1080)p$/i.exec(trimmed);
  return match ? `${match[1]}p` : trimmed;
}

export function veoOperationName(payload: unknown) {
  return text(jsonObject(payload)?.name);
}

export function veoVideoUri(payload: unknown) {
  return pickString(payload, ['uri']);
}

export function veoVideoBase64(payload: unknown) {
  return pickString(payload, ['bytesBase64Encoded', 'videoBytes']);
}

function veoImage(asset: { mimeType: string; bytes: Uint8Array }) {
  const mime = asset.mimeType === 'image/jpeg' || asset.mimeType === 'image/webp' ? asset.mimeType : 'image/png';
  return { bytesBase64Encoded: Buffer.from(asset.bytes).toString('base64'), mimeType: mime };
}

export function minimaxApiRoot(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v[12](?:\/.*)?$/i, '');
}

export function minimaxResolution(value: string) {
  const trimmed = value.trim();
  if (/^2k$/i.test(trimmed)) return '2K';
  if (/^768p$/i.test(trimmed)) return '768P';
  if (/^1080p$/i.test(trimmed)) return '1080P';
  return trimmed;
}

export function minimaxTaskId(payload: unknown) {
  const object = jsonObject(payload);
  return text(object?.task_id) ?? text(jsonObject(object?.task)?.id) ?? text(object?.id);
}

export function minimaxTaskStatus(payload: unknown) {
  const object = jsonObject(payload);
  const task = jsonObject(object?.task) ?? object;
  return text(task?.status)?.toLowerCase();
}

export function minimaxVideoUrl(payload: unknown) {
  const object = jsonObject(payload);
  const task = jsonObject(object?.task) ?? object;
  return text(jsonObject(task?.content)?.url) ?? pickString(payload, ['url']);
}

export function runwayApiRoot(baseUrl: string) {
  let url = baseUrl.trim().replace(/\/+$/, '');
  url = url.replace(/\/v1(?:\/.*)?$/i, '');
  return url.replace(/\/+$/, '');
}

export function runwayHeaders(headers: Record<string, string>, extra?: Record<string, string>) {
  const result: Record<string, string> = { ...headers, ...extra };
  if (!Object.keys(result).some((name) => name.toLowerCase() === 'x-runway-version')) {
    result['X-Runway-Version'] = '2024-11-06';
  }
  return result;
}

export function runwayRatio(value: string) {
  const trimmed = value.trim();
  const named: Record<string, string> = {
    '16:9': '1280:720',
    '9:16': '720:1280',
    '1:1': '960:960',
    '4:3': '1104:832',
    '3:4': '832:1104',
    '21:9': '1584:672',
    '3:2': '1280:768',
    '2:3': '768:1280',
  };
  if (named[trimmed]) return named[trimmed];
  const pixels = /^(\d{3,5})[:xX×](\d{3,5})$/.exec(trimmed);
  if (pixels && Number(pixels[1]) >= 256 && Number(pixels[2]) >= 256) return `${pixels[1]}:${pixels[2]}`;
  return trimmed;
}

export function runwayTaskId(payload: unknown) {
  return text(jsonObject(payload)?.id);
}

export function runwayStatus(payload: unknown) {
  return text(jsonObject(payload)?.status)?.toUpperCase();
}

export function runwayOutputUrl(payload: unknown) {
  const object = jsonObject(payload);
  const output = object?.output;
  if (typeof output === 'string' && output.trim()) return output.trim();
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string' && item.trim()) return item.trim();
      const nested = text(jsonObject(item)?.url) ?? text(jsonObject(item)?.uri);
      if (nested) return nested;
    }
  }
  return pickString(payload, ['url']);
}

export function runwayVideoUrl(payload: unknown) {
  return runwayOutputUrl(payload);
}

export async function testRunwayConnection(deps: Pick<VideoAdapterDeps, 'http' | 'headers' | 'baseUrl' | 'timeoutSeconds'>) {
  try {
    const response = await deps.http.request(`${runwayApiRoot(deps.baseUrl)}/v1/tasks/00000000-0000-4000-8000-000000000000`, {
      method: 'GET',
      headers: runwayHeaders(deps.headers),
      redirectPolicy: 'same-origin',
      signal: AbortSignal.timeout(Math.min(Math.max(deps.timeoutSeconds, 10), 30) * 1000),
    }, MAX_ERROR_BYTES);
    if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key 是否来自 Runway Dev，以及 Base URL 是否为 https://api.dev.runwayml.com' };
    return { ok: true, status: response.status };
  } catch {
    return { ok: false, message: '供应商连接失败' };
  }
}



function throwIfMinimaxFailed(payload: unknown) {
  const object = jsonObject(payload);
  const resp = jsonObject(object?.base_resp);
  const code = resp?.status_code;
  if (typeof code === 'number' && code !== 0) {
    const detail = text(resp?.status_msg);
    const error: any = new Error(detail || `供应商返回 ${code}`);
    error.noRetry = true;
    error.providerFailure = {
      code: 'PROVIDER_PARAMETERS',
      message: detail ? `供应商拒绝了视频或模型参数：${detail}` : '供应商拒绝了视频或模型参数，请管理员检查模型 ID、比例、时长和分辨率',
    };
    throw error;
  }
}

function veoHeaders(deps: VideoAdapterDeps, extra?: Record<string, string>) {
  const headers = requestHeaders(deps, extra);
  const key = bearerToken(headers);
  if (key && !Object.keys(headers).some((name) => name.toLowerCase() === 'x-goog-api-key')) {
    headers['x-goog-api-key'] = key;
  }
  return headers;
}

abstract class BaseVideoAdapter implements MediaGenerationAdapter {
  abstract readonly kind: string;
  readonly mediaKind = 'VIDEO' as const;
  private pollDeadlineAt?: number;
  private pollAttempt = 0;
  constructor(protected readonly deps: VideoAdapterDeps) {}

  abstract createTask(request: MediaGenerationRequest): Promise<string>;
  abstract collect(taskId: string, request: MediaGenerationRequest): Promise<import('./provider-adapter').GeneratedMedia[]>;
  abstract testConnection(): Promise<{ ok: boolean; status?: number; message?: string }>;

  protected deadline() {
    this.pollDeadlineAt ??= (this.deps.now ?? Date.now)() + videoPollTimeoutMs(this.deps);
    return this.pollDeadlineAt;
  }

  protected abort(kind: 'short' | 'long' = 'short') {
    const timeoutMs = kind === 'long' ? videoLongTimeoutMs(this.deps) : videoHttpTimeoutMs(this.deps);
    return { signal: this.deps.signal ?? AbortSignal.timeout(timeoutMs), timeoutMs };
  }

  protected async wait(signal?: AbortSignal) {
    await (this.deps.sleep ?? defaultSleep)(pollDelayMs(this.pollAttempt), signal ?? this.deps.signal);
    this.pollAttempt += 1;
  }

  protected timedOut() {
    return (this.deps.now ?? Date.now)() >= this.deadline();
  }

  protected headers(extra?: Record<string, string>) {
    return requestHeaders(this.deps, extra);
  }

  protected async getJson(url: string) {
    const response = await this.deps.http.request(url, {
      method: 'GET',
      headers: this.headers(),
      redirectPolicy: 'same-origin',
      ...this.abort('short'),
    }, MAX_ERROR_BYTES);
    if (!response.ok) throwHttp(response.status, response.body);
    const payload = parseJsonBody(response.body);
    if (payload === undefined) throw providerProtocolError('供应商返回的 JSON 无法解析');
    return payload;
  }

  protected async postJson(url: string, body: unknown, extraHeaders?: Record<string, string>) {
    const response = await this.deps.http.request(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', ...extraHeaders }),
      body: JSON.stringify(body),
      redirectPolicy: 'same-origin',
      ...this.abort('long'),
    }, MAX_ERROR_BYTES);
    if (!response.ok) throwHttp(response.status, response.body);
    const payload = parseJsonBody(response.body);
    if (payload === undefined) throw providerProtocolError('供应商返回的 JSON 无法解析');
    return payload;
  }

  protected async downloadVideo(url: string, credentialed = false, followCrossOrigin = false) {
    const destination = this.deps.createStagingPath
      ? await this.deps.createStagingPath('.mp4')
      : undefined;
    const init = {
      method: 'GET' as const,
      headers: credentialed ? this.headers() : undefined,
      redirectPolicy: credentialed && !followCrossOrigin ? 'same-origin' as const : 'any' as const,
      ...this.abort('long'),
    };
    if (!destination) {
      const response = await this.deps.http.request(url, init, MAX_VIDEO_BYTES);
      if (!response.ok) throwHttp(response.status, response.body);
      const type = response.headers.get('content-type') ?? '';
      if (type && !/video\/mp4|application\/octet-stream/i.test(type)) throw providerProtocolError('供应商视频类型无效');
      return { mimeType: 'video/mp4' as const, bytes: new Uint8Array(response.body) };
    }
    const response = await this.deps.http.requestToFile(url, init, destination, MAX_VIDEO_BYTES, MAX_ERROR_BYTES);
    if (!response.ok) throwHttp(response.status, response.body);
    const type = response.headers.get('content-type') ?? '';
    if (type && !/video\/mp4|application\/octet-stream/i.test(type)) throw providerProtocolError('供应商视频类型无效');
    return { mimeType: 'video/mp4' as const, path: destination };
  }
}

class OpenAIVideosAdapter extends BaseVideoAdapter {
  readonly kind = 'openai-videos';

  async createTask(request: MediaGenerationRequest) {
    const source = firstSource(request);
    const seconds = durationSecondsOf(request.parameters);
    const size = aspectRatioOf(request.parameters);
    const quality = resolutionOf(request.parameters);
    const payload: Json = {
      model: request.upstreamModelId,
      prompt: request.prompt,
      seconds: String(seconds),
      ...(size ? { size: openaiVideoSize(size, quality) } : {}),
    };
    let body: unknown = JSON.stringify(payload);
    const extra: Record<string, string> = {};
    if (source) {
      const form = new UndiciFormData();
      for (const [key, value] of Object.entries(payload)) form.set(key, String(value));
      form.set('input_reference', new Blob([Buffer.from(source.bytes)], { type: source.mimeType }), 'reference.png');
      body = form;
    } else extra['Content-Type'] = 'application/json';
    const response = await this.deps.http.request(`${this.deps.baseUrl}/videos`, {
      method: 'POST',
      headers: this.headers(extra),
      body: body as any,
      redirectPolicy: 'same-origin',
      ...this.abort('long'),
    }, MAX_ERROR_BYTES);
    if (!response.ok) throwHttp(response.status, response.body);
    const id = openaiVideoTaskId(parseJsonBody(response.body));
    if (!id) throw providerProtocolError('供应商未返回视频任务 ID');
    return id;
  }

  async collect(taskId: string, _request?: MediaGenerationRequest) {
    while (true) {
      if (this.timedOut()) throw providerTimeoutError();
      const payload = await this.getJson(`${this.deps.baseUrl}/videos/${taskId}`);
      const status = openaiVideoStatus(payload);
      if (status === 'completed') return [await this.downloadVideo(`${this.deps.baseUrl}/videos/${taskId}/content`, true)];
      if (status === 'failed' || status === 'cancelled') {
        const error: any = new Error('供应商视频任务失败');
        error.noRetry = true;
        error.providerFailure = { code: 'PROVIDER_PARAMETERS', message: '供应商视频任务失败，请调整提示词或参数后重试' };
        throw error;
      }
      await this.wait();
    }
  }

  async testConnection() {
    return testModelsList(this.deps);
  }
}

class SeedanceAdapter extends BaseVideoAdapter {
  readonly kind = 'seedance';

  async createTask(request: MediaGenerationRequest) {
    const sources = request.inputAssets.filter((asset) => asset.role === 'SOURCE');
    const content: Json[] = [{ type: 'text', text: request.prompt }];
    if (sources[0]) content.push({ type: 'image_url', image_url: { url: dataUrl(sources[0]) }, role: 'first_frame' });
    if (sources[1]) content.push({ type: 'image_url', image_url: { url: dataUrl(sources[1]) }, role: 'last_frame' });
    const ratio = aspectRatioOf(request.parameters);
    const resolution = resolutionOf(request.parameters);
    const payload = await this.postJson(`${this.deps.baseUrl}/contents/generations/tasks`, {
      model: request.upstreamModelId,
      content,
      duration: durationSecondsOf(request.parameters),
      watermark: false,
      ...(ratio ? { ratio } : {}),
      ...(resolution ? { resolution } : {}),
    });
    const id = seedanceTaskId(payload);
    if (!id) throw providerProtocolError('供应商未返回视频任务 ID');
    return id;
  }

  async collect(taskId: string, _request?: MediaGenerationRequest) {
    while (true) {
      if (this.timedOut()) throw providerTimeoutError();
      const payload = await this.getJson(`${this.deps.baseUrl}/contents/generations/tasks/${taskId}`);
      const status = seedanceStatus(payload);
      if (status === 'succeeded' || status === 'success' || status === 'completed') {
        const url = seedanceVideoUrl(payload);
        if (!url) throw providerProtocolError('供应商未返回视频地址');
        return [await this.downloadVideo(url)];
      }
      if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        const error: any = new Error('供应商视频任务失败');
        error.noRetry = true;
        error.providerFailure = { code: 'PROVIDER_PARAMETERS', message: '供应商视频任务失败，请调整提示词或参数后重试' };
        throw error;
      }
      await this.wait();
    }
  }

  async testConnection() {
    const models = await testModelsList(this.deps);
    if (models.ok) return models;
    try {
      const response = await this.deps.http.request(`${this.deps.baseUrl}/contents/generations/tasks`, {
        method: 'GET',
        headers: this.headers(),
        redirectPolicy: 'same-origin',
        ...this.abort('short'),
      }, MAX_ERROR_BYTES);
      if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key、令牌分组及访问权限' };
      return { ok: true, status: response.status };
    } catch {
      return { ...models, ok: false, message: models.message ?? '供应商连接失败' };
    }
  }
}

class WanAdapter extends BaseVideoAdapter {
  readonly kind = 'wan';

  async createTask(request: MediaGenerationRequest) {
    const root = wanApiRoot(this.deps.baseUrl);
    const payload = await this.postJson(`${root}${WAN_SYNTHESIS_PATH}`, {
      model: request.upstreamModelId,
      input: wanInput(request),
      parameters: wanParameters(request.parameters),
    }, { 'X-DashScope-Async': 'enable' });
    throwIfDashScopeFailed(payload);
    const id = wanTaskId(payload);
    if (!id) throw providerProtocolError('供应商未返回视频任务 ID');
    return id;
  }

  async collect(taskId: string, _request?: MediaGenerationRequest) {
    const root = wanApiRoot(this.deps.baseUrl);
    while (true) {
      if (this.timedOut()) throw providerTimeoutError();
      const payload = await this.getJson(`${root}/tasks/${taskId}`);
      const status = wanStatus(payload);
      if (status === 'SUCCEEDED') {
        const url = wanVideoUrl(payload);
        if (!url) throw providerProtocolError('供应商未返回视频地址');
        return [await this.downloadVideo(url)];
      }
      if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
        const object = jsonObject(payload);
        const output = jsonObject(object?.output);
        const detail = text(output?.message) ?? text(object?.message) ?? text(output?.code);
        const error: any = new Error(detail || '供应商视频任务失败');
        error.noRetry = true;
        error.providerFailure = { code: 'PROVIDER_PARAMETERS', message: detail ? `供应商视频任务失败：${detail}` : '供应商视频任务失败，请调整提示词或参数后重试' };
        throw error;
      }
      await this.wait();
    }
  }

  async testConnection() {
    try {
      const response = await this.deps.http.request(`${wanApiRoot(this.deps.baseUrl)}/tasks/0`, {
        method: 'GET',
        headers: this.headers(),
        redirectPolicy: 'same-origin',
        ...this.abort('short'),
      }, MAX_ERROR_BYTES);
      if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key、令牌分组及访问权限' };
      return { ok: true, status: response.status };
    } catch {
      return { ok: false, message: '供应商连接失败' };
    }
  }
}

class VeoAdapter extends BaseVideoAdapter {
  readonly kind = 'veo';

  protected headers(extra?: Record<string, string>) {
    return veoHeaders(this.deps, extra);
  }

  async createTask(request: MediaGenerationRequest) {
    const root = veoApiRoot(this.deps.baseUrl);
    const sources = request.inputAssets.filter((asset) => asset.role === 'SOURCE');
    const instance: Json = { prompt: request.prompt };
    if (sources[0]) instance.image = veoImage(sources[0]);
    const references = sources.slice(1, 4);
    if (references.length) instance.referenceImages = references.map((asset) => ({ image: veoImage(asset), referenceType: 'asset' }));
    const parameters: Json = {};
    const aspect = aspectRatioOf(request.parameters);
    if (aspect) parameters.aspectRatio = aspect;
    const duration = durationSecondsOf(request.parameters);
    if (duration) parameters.durationSeconds = duration;
    const resolution = resolutionOf(request.parameters);
    if (resolution) parameters.resolution = veoResolution(resolution);
    const payload = await this.postJson(`${root}/models/${request.upstreamModelId}:predictLongRunning`, {
      instances: [instance],
      ...(Object.keys(parameters).length ? { parameters } : {}),
    });
    const error = jsonObject(jsonObject(payload)?.error);
    if (error) {
      const detail = text(error.message);
      const failure: any = new Error(detail || '供应商拒绝了视频或模型参数');
      failure.noRetry = true;
      failure.providerFailure = { code: 'PROVIDER_PARAMETERS', message: detail ? `供应商拒绝了视频或模型参数：${detail}` : '供应商拒绝了视频或模型参数，请管理员检查模型 ID、比例、时长和分辨率' };
      throw failure;
    }
    const id = veoOperationName(payload);
    if (!id) throw providerProtocolError('供应商未返回视频任务 ID');
    return id;
  }

  async collect(taskId: string, _request?: MediaGenerationRequest) {
    const root = veoApiRoot(this.deps.baseUrl);
    while (true) {
      if (this.timedOut()) throw providerTimeoutError();
      const payload = await this.getJson(veoOperationUrl(root, taskId));
      const error = jsonObject(jsonObject(payload)?.error);
      if (error) {
        const detail = text(error.message);
        const failure: any = new Error(detail || '供应商视频任务失败');
        failure.noRetry = true;
        failure.providerFailure = { code: 'PROVIDER_PARAMETERS', message: detail ? `供应商视频任务失败：${detail}` : '供应商视频任务失败，请调整提示词或参考图后重试' };
        throw failure;
      }
      if (jsonObject(payload)?.done === true) {
        const inline = veoVideoBase64(payload);
        if (inline) {
          const bytes = Buffer.from(inline, 'base64');
          if (this.deps.createStagingPath) {
            const path = await this.deps.createStagingPath('.mp4');
            await writeFile(path, bytes, { flag: 'wx' });
            return [{ mimeType: 'video/mp4' as const, path }];
          }
          return [{ mimeType: 'video/mp4' as const, bytes: new Uint8Array(bytes) }];
        }
        const uri = veoVideoUri(payload);
        if (!uri) throw providerProtocolError('供应商未返回视频地址');
        return [await this.downloadVideo(uri, true, true)];
      }
      await this.wait();
    }
  }

  async testConnection() {
    try {
      const response = await this.deps.http.request(`${veoApiRoot(this.deps.baseUrl)}/models`, {
        method: 'GET',
        headers: this.headers(),
        redirectPolicy: 'same-origin',
        ...this.abort('short'),
      }, MAX_ERROR_BYTES);
      if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key 是否来自 Google AI Studio，以及 Base URL 是否为 https://generativelanguage.googleapis.com/v1beta' };
      if (response.status === 404) return { ok: false, status: response.status, message: '模型列表接口不存在，请检查 Base URL 是否为 https://generativelanguage.googleapis.com/v1beta' };
      return { ok: true, status: response.status };
    } catch {
      return { ok: false, message: '供应商连接失败' };
    }
  }
}

class RunwayAdapter extends BaseVideoAdapter {
  readonly kind = 'runway';

  protected headers(extra?: Record<string, string>) {
    return runwayHeaders(super.headers(extra));
  }

  async createTask(request: MediaGenerationRequest) {
    const root = runwayApiRoot(this.deps.baseUrl);
    const sources = request.inputAssets.filter((asset) => asset.role === 'SOURCE');
    const payload: Json = {
      model: request.upstreamModelId,
      promptText: request.prompt,
    };
    const ratio = aspectRatioOf(request.parameters);
    if (ratio) payload.ratio = runwayRatio(ratio);
    const duration = durationSecondsOf(request.parameters);
    if (duration) payload.duration = duration;
    const path = sources[0] ? '/v1/image_to_video' : '/v1/text_to_video';
    if (sources[0]) {
      payload.promptImage = sources.length === 1
        ? dataUrl(sources[0])
        : sources.slice(0, 2).map((asset, index) => ({ uri: dataUrl(asset), position: index === 0 ? 'first' : 'last' }));
    }
    const result = await this.postJson(`${root}${path}`, payload);
    const id = runwayTaskId(result);
    if (!id) throw providerProtocolError('供应商未返回视频任务 ID');
    return id;
  }

  async collect(taskId: string, _request?: MediaGenerationRequest) {
    const root = runwayApiRoot(this.deps.baseUrl);
    while (true) {
      if (this.timedOut()) throw providerTimeoutError();
      const payload = await this.getJson(`${root}/v1/tasks/${encodeURIComponent(taskId)}`);
      const status = runwayStatus(payload);
      if (status === 'SUCCEEDED' || status === 'SUCCESS' || status === 'COMPLETED') {
        const url = runwayVideoUrl(payload);
        if (!url) throw providerProtocolError('供应商未返回视频地址');
        return [await this.downloadVideo(url)];
      }
      if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
        const detail = text(jsonObject(payload)?.failure) ?? text(jsonObject(jsonObject(payload)?.error)?.message) ?? text(jsonObject(payload)?.error);
        const error: any = new Error(detail || '供应商视频任务失败');
        error.noRetry = true;
        error.providerFailure = { code: 'PROVIDER_PARAMETERS', message: detail ? `供应商视频任务失败：${detail}` : '供应商视频任务失败，请调整提示词或参考图后重试' };
        throw error;
      }
      await this.wait();
    }
  }

  async testConnection() {
    return testRunwayConnection(this.deps);
  }
}

class FluxVideoAdapter extends BaseVideoAdapter {
  readonly kind = 'flux-video';

  protected headers(extra?: Record<string, string>) {
    return fluxHeaders(super.headers(extra));
  }

  async createTask(request: MediaGenerationRequest) {
    const sources = request.inputAssets.filter((asset) => asset.role === 'SOURCE');
    const payload: Json = {
      mode: sources.length ? 'i2v' : 't2v',
      prompt: request.prompt,
    };
    const aspect = fluxVideoAspect(aspectRatioOf(request.parameters));
    if (aspect) payload.aspect_ratio = aspect;
    const duration = durationSecondsOf(request.parameters);
    if (duration >= 5 && duration <= 20) payload.duration = duration;
    const resolution = resolutionOf(request.parameters);
    if (resolution) payload.resolution = fluxVideoResolution(resolution);
    if (sources.length === 1) payload.keyframes = dataUrl(sources[0]);
    else if (sources.length === 2) payload.keyframes = [dataUrl(sources[0]), dataUrl(sources[1])];
    else if (sources.length > 2) {
      const span = typeof payload.duration === 'number' ? payload.duration : 10;
      const last = Math.min(sources.length, 10) - 1;
      payload.keyframes = sources.slice(0, 10).map((asset, index) => [
        last <= 0 ? 0 : Math.round((span * index / last) * 10) / 10,
        dataUrl(asset),
      ]);
    }
    const result = await this.postJson(`${fluxApiRoot(this.deps.baseUrl)}/${fluxVideoPath(request.upstreamModelId)}`, payload);
    const id = fluxTaskId(result);
    if (!id) throw providerProtocolError('供应商未返回视频任务 ID');
    return fluxTaskToken(id, fluxPollingUrl(result));
  }

  async collect(taskId: string, _request?: MediaGenerationRequest) {
    const url = await pollFluxUntilReady(this.deps, taskId);
    return [await this.downloadVideo(url)];
  }

  async testConnection() {
    return testFluxConnection(this.deps);
  }
}

class MiniMaxH3Adapter extends BaseVideoAdapter {
  readonly kind = 'minimax';

  async createTask(request: MediaGenerationRequest) {
    const sources = request.inputAssets.filter((asset) => asset.role === 'SOURCE');
    const content: Json[] = [{ type: 'text', text: request.prompt }];
    if (sources[0]) content.push({ type: 'image_url', image_url: { url: dataUrl(sources[0]) }, role: 'first_frame' });
    if (sources[1]) content.push({ type: 'image_url', image_url: { url: dataUrl(sources[1]) }, role: 'last_frame' });
    const ratio = aspectRatioOf(request.parameters);
    const resolution = resolutionOf(request.parameters);
    const payload = await this.postJson(`${minimaxApiRoot(this.deps.baseUrl)}/v2/video_generation`, {
      model: request.upstreamModelId,
      content,
      duration: durationSecondsOf(request.parameters),
      ...(resolution ? { resolution: minimaxResolution(resolution) } : {}),
      ...(!sources.length && ratio ? { ratio } : {}),
    });
    throwIfMinimaxFailed(payload);
    const id = minimaxTaskId(payload);
    if (!id) throw providerProtocolError('供应商未返回视频任务 ID');
    return id;
  }

  async collect(taskId: string, _request?: MediaGenerationRequest) {
    const root = minimaxApiRoot(this.deps.baseUrl);
    while (true) {
      if (this.timedOut()) throw providerTimeoutError();
      const payload = await this.getJson(`${root}/v2/query/video_generation/${taskId}`);
      throwIfMinimaxFailed(payload);
      const status = minimaxTaskStatus(payload);
      if (status === 'succeeded' || status === 'success' || status === 'completed') {
        const url = minimaxVideoUrl(payload);
        if (!url) throw providerProtocolError('供应商未返回视频地址');
        return [await this.downloadVideo(url)];
      }
      if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
        const task = jsonObject(jsonObject(payload)?.task) ?? jsonObject(payload);
        const detail = text(jsonObject(task?.error)?.message) ?? text(task?.error);
        const error: any = new Error(detail || '供应商视频任务失败');
        error.noRetry = true;
        error.providerFailure = { code: 'PROVIDER_PARAMETERS', message: detail ? `供应商视频任务失败：${detail}` : '供应商视频任务失败，请调整提示词或参考图后重试' };
        throw error;
      }
      await this.wait();
    }
  }

  async testConnection() {
    try {
      const response = await this.deps.http.request(`${minimaxApiRoot(this.deps.baseUrl)}/v2/query/video_generation?page_num=1&page_size=1`, {
        method: 'GET',
        headers: this.headers(),
        redirectPolicy: 'same-origin',
        ...this.abort('short'),
      }, MAX_ERROR_BYTES);
      if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key 是否来自 MiniMax 开放平台' };
      if (response.status === 404) return { ok: false, status: response.status, message: '任务查询接口不存在，请检查 Base URL 是否为 https://api.minimaxi.com 或 https://api.minimax.io' };
      return { ok: true, status: response.status };
    } catch {
      return { ok: false, message: '供应商连接失败' };
    }
  }
}

export async function testModelsList(deps: Pick<VideoAdapterDeps, 'http' | 'headers' | 'baseUrl' | 'timeoutSeconds'>) {
  try {
    const response = await deps.http.request(`${deps.baseUrl}/models`, {
      method: 'GET',
      headers: deps.headers,
      redirectPolicy: 'same-origin',
      signal: AbortSignal.timeout(Math.min(Math.max(deps.timeoutSeconds, 10), 30) * 1000),
    }, MAX_ERROR_BYTES);
    const contentType = response.headers.get('content-type') ?? '';
    let modelsPayload = false;
    if (response.ok && contentType.includes('application/json')) {
      try { modelsPayload = Array.isArray(JSON.parse(response.body.toString('utf8'))?.data); } catch { /* invalid JSON */ }
    }
    if (response.ok && modelsPayload) return { ok: true, status: response.status };
    if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key、令牌分组及访问权限' };
    if (response.status === 404) return { ok: false, status: response.status, message: '模型列表接口不存在，请检查 Base URL 是否包含正确的 /v1' };
    if (response.ok && !modelsPayload) return { ok: false, status: response.status, message: '接口返回的不是模型列表，请检查 Base URL 是否包含正确的 /v1' };
    if (response.status === 429) return { ok: false, status: response.status, message: '供应商限流或账户额度不足' };
    if (response.status >= 500) return { ok: false, status: response.status, message: '供应商服务暂时不可用' };
    return { ok: false, status: response.status, message: '模型列表接口测试失败' };
  } catch {
    return { ok: false, message: '供应商连接失败' };
  }
}

export function createVideoAdapter(kind: string, deps: VideoAdapterDeps): MediaGenerationAdapter {
  if (kind === 'openai-videos') return new OpenAIVideosAdapter(deps);
  if (kind === 'seedance') return new SeedanceAdapter(deps);
  if (kind === 'wan') return new WanAdapter(deps);
  if (kind === 'veo') return new VeoAdapter(deps);
  if (kind === 'minimax') return new MiniMaxH3Adapter(deps);
  if (kind === 'runway') return new RunwayAdapter(deps);
  if (kind === 'flux-video') return new FluxVideoAdapter(deps);
  throw new Error(`未知视频适配器：${kind}`);
}

export function canCreateVideoAdapter(kind: string) {
  return isVideoAdapterKind(kind);
}
