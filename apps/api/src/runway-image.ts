/**
 * Runway image adapter.
 * Speaks POST {root}/v1/text_to_image with X-Runway-Version, then polls
 * GET {root}/v1/tasks/{id} until SUCCEEDED. output[] is a signed image URL.
 *
 * Text-to-image and reference-image editing (referenceImages, up to 3).
 * Mask inpainting has no Runway counterpart and is rejected by the processor.
 */
import { pollDelayMs } from './domain-constants';
import { MAX_ERROR_BYTES } from './safe-http.service';
import {
  jsonObject,
  parseJsonBody,
  providerProtocolError,
  providerTimeoutError,
  sleep as defaultSleep,
  text,
  type JsonObject,
  type VideoAdapterDeps,
} from './provider-adapter';
import {
  runwayApiRoot,
  runwayHeaders,
  runwayOutputUrl,
  runwayStatus,
  runwayTaskId,
  testRunwayConnection,
} from './video-adapters';

type Json = JsonObject;

export const RUNWAY_IMAGE_RATIOS = [
  '1024:1024', '1080:1080', '720:720',
  '1280:720', '1920:1080', '720:1280', '1080:1920',
  '1168:880', '1360:768', '1440:1080', '1080:1440',
  '1808:768', '2112:912', '960:720', '720:960', '1680:720',
] as const;

function parsePixels(value: string) {
  const match = /^(\d{2,5})[:xX×](\d{2,5})$/.exec(value.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  return { width, height };
}

function prefer1080(size: { width: number; height: number } | undefined, quality?: unknown) {
  if (typeof quality === 'string' && /^(1080p|fhd|2k|high)$/i.test(quality.trim())) return true;
  if (typeof quality === 'string' && /^(720p|hd|1k|low|standard)$/i.test(quality.trim())) return false;
  if (!size) return false;
  return Math.max(size.width, size.height) >= 1400;
}

function closestImageRatio(width: number, height: number) {
  let best: string = RUNWAY_IMAGE_RATIOS[0];
  let bestScore = Infinity;
  const aspect = width / height;
  const area = width * height;
  for (const ratio of RUNWAY_IMAGE_RATIOS) {
    const parsed = parsePixels(ratio);
    if (!parsed) continue;
    const aspectDiff = Math.abs(aspect - parsed.width / parsed.height);
    const scaleDiff = Math.abs(Math.log(area / (parsed.width * parsed.height)));
    const score = aspectDiff * 8 + scaleDiff;
    if (score < bestScore) {
      bestScore = score;
      best = ratio;
    }
  }
  return best;
}

/** Maps a stored WxH / named ratio onto a Runway image pixel ratio. */
export function runwayImageRatio(size: unknown, quality?: unknown) {
  const raw = String(size ?? '').trim();
  const named720: Record<string, string> = {
    '16:9': '1280:720',
    '9:16': '720:1280',
    '1:1': '1024:1024',
    '4:3': '960:720',
    '3:4': '720:960',
    '21:9': '1680:720',
    '3:2': '1168:880',
    '2:3': '720:960',
  };
  const named1080: Record<string, string> = {
    '16:9': '1920:1080',
    '9:16': '1080:1920',
    '1:1': '1080:1080',
    '4:3': '1440:1080',
    '3:4': '1080:1440',
    '21:9': '2112:912',
    '3:2': '1440:1080',
    '2:3': '1080:1440',
  };
  const pixels = parsePixels(raw);
  const hi = prefer1080(pixels, quality);
  if ((RUNWAY_IMAGE_RATIOS as readonly string[]).includes(raw.replace(/[xX×]/g, ':'))) {
    return raw.replace(/[xX×]/g, ':');
  }
  if (named720[raw]) return hi ? named1080[raw] : named720[raw];
  if (pixels) return closestImageRatio(pixels.width, pixels.height);
  return hi ? '1080:1080' : '1024:1024';
}

export function runwayImageRequestBody(
  modelId: string,
  prompt: string,
  parameters: { size?: unknown; quality?: unknown },
  imageDataUrls: string[] = [],
) {
  const body: Json = {
    model: modelId,
    promptText: prompt,
    ratio: runwayImageRatio(parameters.size, parameters.quality),
  };
  if (imageDataUrls.length) {
    body.referenceImages = imageDataUrls.slice(0, 3).map((uri, index) => ({ uri, tag: `image${index + 1}` }));
  }
  return body;
}

function runwayErrorMessage(body?: Buffer) {
  if (!body?.length) return undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : undefined;
    if (!object) return undefined;
    const error = object.error;
    if (typeof error === 'string' && error.trim()) return error.trim();
    const nested = jsonObject(error);
    const message = nested?.message ?? object.message ?? object.failure;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
  } catch { return undefined; }
}

export function runwayImageFailure(status: number, body?: Buffer) {
  const message = runwayErrorMessage(body);
  if ((status === 400 || status === 422) && /moderat|safety|blocked|prohibited/i.test(message ?? '')) {
    return { code: 'PROVIDER_MODERATION', message: '请求或生成结果被供应商安全检查拒绝，请调整提示词或参考图后重试' };
  }
  if (status === 400 || status === 422) {
    return { code: 'PROVIDER_PARAMETERS', message: message ? `供应商拒绝了图片或模型参数：${message}` : '供应商拒绝了图片或模型参数，请管理员检查模型 ID、参考图、比例和分辨率' };
  }
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH', message: '供应商认证失败，请检查 API Key 是否来自 Runway Dev，以及 Base URL 是否为 https://api.dev.runwayml.com' };
  if (status === 404) {
    return { code: 'PROVIDER_NOT_FOUND', message: message
      ? `供应商接口或模型不存在：${message}`
      : '供应商接口或模型不存在。Base URL 填 https://api.dev.runwayml.com，模型 ID 例如 gen4_image、gen4_image_turbo。' };
  }
  if (status === 402 || status === 429) return { code: 'PROVIDER_LIMIT', message: '供应商限流或账户额度不足，请稍后重试' };
  return { code: 'PROVIDER_UNAVAILABLE', message: message ? `供应商服务暂时不可用：${message}` : '供应商服务暂时不可用，请稍后重试' };
}

function throwRunwayHttp(status: number, body?: Buffer) {
  const error: any = new Error(`供应商返回 ${status}`);
  error.noRetry = status >= 400 && status < 500;
  error.providerFailure = runwayImageFailure(status, body);
  throw error;
}

function abortMs(deps: Pick<VideoAdapterDeps, 'timeoutSeconds' | 'pollTimeoutSeconds'>, kind: 'short' | 'long') {
  const short = Math.min(Math.max(Number(deps.timeoutSeconds) || 180, 10), 3600) * 1000;
  const poll = Math.min(Math.max(Number(deps.pollTimeoutSeconds) || 900, 10), 3600) * 1000;
  return kind === 'long' ? Math.max(short, poll, 120_000) : short;
}

async function runwayGet(deps: VideoAdapterDeps, url: string) {
  const response = await deps.http.request(url, {
    method: 'GET',
    headers: runwayHeaders(deps.headers),
    redirectPolicy: 'same-origin',
    signal: deps.signal ?? AbortSignal.timeout(abortMs(deps, 'short')),
    timeoutMs: abortMs(deps, 'short'),
  } as any, MAX_ERROR_BYTES);
  if (!response.ok) throwRunwayHttp(response.status, response.body);
  const payload = parseJsonBody(response.body);
  if (payload === undefined) throw providerProtocolError('供应商返回的 JSON 无法解析');
  return payload;
}

export async function submitRunwayImage(deps: VideoAdapterDeps, body: unknown) {
  const url = `${runwayApiRoot(deps.baseUrl)}/v1/text_to_image`;
  const response = await deps.http.request(url, {
    method: 'POST',
    headers: runwayHeaders(deps.headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    redirectPolicy: 'same-origin',
    signal: deps.signal ?? AbortSignal.timeout(abortMs(deps, 'long')),
    timeoutMs: abortMs(deps, 'long'),
  } as any, MAX_ERROR_BYTES);
  if (!response.ok) throwRunwayHttp(response.status, response.body);
  const payload = parseJsonBody(response.body);
  const id = runwayTaskId(payload);
  if (!id) throw providerProtocolError('供应商未返回任务 ID');
  return id;
}

export async function pollRunwayImageTask(deps: VideoAdapterDeps, taskId: string) {
  const deadline = (deps.now ?? Date.now)() + Math.min(Math.max(Number(deps.pollTimeoutSeconds) || 900, 10), 3600) * 1000;
  const url = `${runwayApiRoot(deps.baseUrl)}/v1/tasks/${encodeURIComponent(taskId)}`;
  let attempt = 0;
  while (true) {
    if ((deps.now ?? Date.now)() >= deadline) throw providerTimeoutError();
    const payload = await runwayGet(deps, url);
    const status = runwayStatus(payload);
    if (status === 'SUCCEEDED' || status === 'SUCCESS' || status === 'COMPLETED') {
      const imageUrl = runwayOutputUrl(payload);
      if (!imageUrl) throw providerProtocolError('供应商未返回图片地址');
      return imageUrl;
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
      const detail = text(jsonObject(payload)?.failure) ?? text(jsonObject(jsonObject(payload)?.error)?.message) ?? text(jsonObject(payload)?.error);
      const error: any = new Error(detail || '供应商图片任务失败');
      error.noRetry = true;
      error.providerFailure = {
        code: /moderat|safety|blocked/i.test(detail ?? '') ? 'PROVIDER_MODERATION' : 'PROVIDER_PARAMETERS',
        message: detail ? `供应商图片任务失败：${detail}` : '供应商图片任务失败，请调整提示词或参考图后重试',
      };
      throw error;
    }
    await (deps.sleep ?? defaultSleep)(pollDelayMs(attempt), deps.signal);
    attempt += 1;
  }
}

export function testRunwayImageConnection(deps: Pick<VideoAdapterDeps, 'http' | 'headers' | 'baseUrl' | 'timeoutSeconds'>) {
  return testRunwayConnection(deps);
}
