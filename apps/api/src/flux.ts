/**
 * Flux (Black Forest Labs) image adapter.
 * Speaks POST {root}/{model} with x-key, then polls polling_url until Ready.
 * result.sample is a signed image URL (about 10 minutes).
 *
 * Text-to-image and reference-image editing (input_image … input_image_8).
 * Mask inpainting has no BFL counterpart and is rejected by the processor.
 *
 * Video uses the same auth/root; see FluxVideoAdapter in video-adapters.ts.
 */
import { pollDelayMs } from './domain-constants';
import { MAX_ERROR_BYTES } from './safe-http.service';
import {
  bearerToken,
  jsonObject,
  parseJsonBody,
  providerProtocolError,
  providerTimeoutError,
  sleep as defaultSleep,
  text,
  type JsonObject,
  type VideoAdapterDeps,
} from './provider-adapter';

type Json = JsonObject;

function fluxHttpTimeoutMs(deps: Pick<VideoAdapterDeps, 'timeoutSeconds'>) {
  return Math.min(Math.max(Number(deps.timeoutSeconds) || 180, 10), 3600) * 1000;
}

function fluxPollTimeoutMs(deps: Pick<VideoAdapterDeps, 'pollTimeoutSeconds'>) {
  return Math.min(Math.max(Number(deps.pollTimeoutSeconds) || 900, 10), 3600) * 1000;
}

export function fluxApiRoot(baseUrl: string) {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (/^https:\/\/api(?:\.(?:eu|us))?\.bfl\.(?:ai|ml)$/i.test(url)) url += '/v1';
  return url.replace(/\/+$/, '');
}

export function fluxHeaders(headers: Record<string, string>, extra?: Record<string, string>) {
  const result: Record<string, string> = { ...headers, ...extra };
  const key = bearerToken(result);
  if (key && !Object.keys(result).some((name) => name.toLowerCase() === 'x-key')) {
    result['x-key'] = key;
  }
  return result;
}

/** Model ID is the BFL path slug, e.g. flux-2-pro or flux-2-pro-preview. */
export function fluxEndpointSlug(modelId: string) {
  const slug = modelId.trim().replace(/^\/+|\/+$/g, '').replace(/^v1\//i, '');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(slug)) {
    const error: any = new Error('Flux 模型 ID 无效');
    error.noRetry = true;
    error.providerFailure = {
      code: 'PROVIDER_PARAMETERS',
      message: 'Flux 模型 ID 应为 BFL 路径，例如 flux-2-pro、flux-2-pro-preview、flux-2-flex、flux-2-max、flux-kontext-pro',
    };
    throw error;
  }
  return slug;
}

export function fluxVideoPath(modelId: string) {
  const slug = fluxEndpointSlug(modelId);
  return /^flux-3-video/i.test(slug) ? slug : 'flux-3-video';
}

export function fluxTaskToken(id: string, pollingUrl?: string) {
  return pollingUrl ? `${id}|${pollingUrl}` : id;
}

export function fluxTaskParts(token: string) {
  const idx = token.indexOf('|http');
  if (idx === -1) return { id: token.trim(), pollingUrl: undefined as string | undefined };
  return { id: token.slice(0, idx).trim(), pollingUrl: token.slice(idx + 1).trim() };
}

export function fluxPollingUrl(payload: unknown) {
  return text(jsonObject(payload)?.polling_url);
}

export function fluxTaskId(payload: unknown) {
  return text(jsonObject(payload)?.id);
}

export function fluxStatus(payload: unknown) {
  return text(jsonObject(payload)?.status);
}

export function fluxSampleUrl(payload: unknown) {
  const result = jsonObject(jsonObject(payload)?.result);
  return text(result?.sample) ?? text(result?.video) ?? text(jsonObject(payload)?.sample);
}

function round16(value: number) {
  return Math.max(64, Math.round(value / 16) * 16);
}

/** Maps a stored WxH size onto BFL width/height (multiples of 16). */
export function fluxDimensions(size: unknown) {
  const match = /^(\d{1,5})[xX×](\d{1,5})$/.exec(String(size ?? '').trim());
  if (!match) return undefined;
  return { width: round16(Number(match[1])), height: round16(Number(match[2])) };
}

export function fluxRequestBody(
  prompt: string,
  parameters: { size?: unknown },
  imageBase64: string[] = [],
) {
  const body: Json = { prompt, output_format: 'png' };
  const dim = fluxDimensions(parameters.size);
  if (dim) {
    body.width = dim.width;
    body.height = dim.height;
  }
  imageBase64.slice(0, 8).forEach((data, index) => {
    body[index === 0 ? 'input_image' : `input_image_${index + 1}`] = data;
  });
  return body;
}

export function fluxVideoResolution(value: string) {
  const trimmed = value.trim();
  if (/^(720p|hd|1k)$/i.test(trimmed)) return 'hd';
  if (/^(1080p|fhd|2k)$/i.test(trimmed)) return 'fhd';
  if (/^(hd|fhd)$/i.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

export function fluxVideoAspect(value: string) {
  const trimmed = value.trim();
  if (/^(auto|21:9|2:1|16:9|4:3|1:1|3:4|9:16)$/i.test(trimmed)) return trimmed.toLowerCase() === 'auto' ? 'auto' : trimmed;
  const pixels = /^(\d{2,5})[:xX×](\d{2,5})$/.exec(trimmed);
  if (!pixels) return undefined;
  const width = Number(pixels[1]);
  const height = Number(pixels[2]);
  if (!width || !height) return undefined;
  let x = width;
  let y = height;
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  const divisor = x || 1;
  return `${width / divisor}:${height / divisor}`;
}

function bflErrorMessage(body?: Buffer) {
  if (!body?.length) return undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : undefined;
    if (!object) return undefined;
    const detail = object.detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
    if (Array.isArray(detail)) {
      const first = detail.find((item) => item && typeof item === 'object' && typeof (item as Json).msg === 'string') as Json | undefined;
      if (first && typeof first.msg === 'string' && first.msg.trim()) return first.msg.trim();
    }
    const message = object.message ?? object.error;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
  } catch { return undefined; }
}

export function fluxFailure(status: number, body?: Buffer) {
  const message = bflErrorMessage(body);
  if ((status === 400 || status === 422) && /moderat|safety|blocked|prohibited/i.test(message ?? '')) {
    return { code: 'PROVIDER_MODERATION', message: '请求或生成结果被供应商安全检查拒绝，请调整提示词或参考图后重试' };
  }
  if (status === 400 || status === 422) {
    return { code: 'PROVIDER_PARAMETERS', message: message ? `供应商拒绝了图片或模型参数：${message}` : '供应商拒绝了图片或模型参数，请管理员检查模型 ID、参考图、比例和分辨率' };
  }
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH', message: '供应商认证失败，请检查 API Key 是否来自 dashboard.bfl.ai，以及 Base URL 是否为 https://api.bfl.ai' };
  if (status === 404) {
    return { code: 'PROVIDER_NOT_FOUND', message: message
      ? `供应商接口或模型不存在：${message}`
      : '供应商接口或模型不存在。Base URL 填 https://api.bfl.ai，模型 ID 例如 flux-2-pro、flux-2-pro-preview、flux-2-flex、flux-kontext-pro；视频模型 ID 填 flux-3-video。' };
  }
  if (status === 402 || status === 429) return { code: 'PROVIDER_LIMIT', message: '供应商限流或账户额度不足，请稍后重试' };
  return { code: 'PROVIDER_UNAVAILABLE', message: message ? `供应商服务暂时不可用：${message}` : '供应商服务暂时不可用，请稍后重试' };
}

function throwFluxHttp(status: number, body?: Buffer) {
  const error: any = new Error(`供应商返回 ${status}`);
  error.noRetry = status >= 400 && status < 500;
  error.providerFailure = fluxFailure(status, body);
  throw error;
}

function abortMs(deps: Pick<VideoAdapterDeps, 'timeoutSeconds' | 'pollTimeoutSeconds'>, kind: 'short' | 'long') {
  return kind === 'long'
    ? Math.max(fluxHttpTimeoutMs(deps), fluxPollTimeoutMs(deps), 120_000)
    : fluxHttpTimeoutMs(deps);
}

async function fluxGet(deps: VideoAdapterDeps, url: string) {
  const response = await deps.http.request(url, {
    method: 'GET',
    headers: fluxHeaders(deps.headers),
    redirectPolicy: 'same-origin',
    signal: deps.signal ?? AbortSignal.timeout(abortMs(deps, 'short')),
    timeoutMs: abortMs(deps, 'short'),
  } as any, MAX_ERROR_BYTES);
  if (!response.ok) throwFluxHttp(response.status, response.body);
  const payload = parseJsonBody(response.body);
  if (payload === undefined) throw providerProtocolError('供应商返回的 JSON 无法解析');
  return payload;
}

export async function submitFluxRequest(deps: VideoAdapterDeps, path: string, body: unknown) {
  const url = `${fluxApiRoot(deps.baseUrl)}/${path.replace(/^\/+/, '')}`;
  const response = await deps.http.request(url, {
    method: 'POST',
    headers: fluxHeaders(deps.headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    redirectPolicy: 'same-origin',
    signal: deps.signal ?? AbortSignal.timeout(abortMs(deps, 'long')),
    timeoutMs: abortMs(deps, 'long'),
  } as any, MAX_ERROR_BYTES);
  if (!response.ok) throwFluxHttp(response.status, response.body);
  const payload = parseJsonBody(response.body);
  const id = fluxTaskId(payload);
  const pollingUrl = fluxPollingUrl(payload);
  if (!id) throw providerProtocolError('供应商未返回任务 ID');
  return fluxTaskToken(id, pollingUrl);
}

export function fluxPollUrl(baseUrl: string, token: string) {
  const { id, pollingUrl } = fluxTaskParts(token);
  if (pollingUrl) return pollingUrl;
  return `${fluxApiRoot(baseUrl)}/get_result?id=${encodeURIComponent(id)}`;
}

function throwIfFluxFailed(payload: unknown) {
  const status = fluxStatus(payload);
  if (!status) return;
  if (/^(Error|Failed|Request Moderated|Content Moderated)$/i.test(status)) {
    const detail = text(jsonObject(payload)?.error) ?? text(jsonObject(jsonObject(payload)?.result)?.error) ?? status;
    const moderated = /moderat/i.test(status);
    const error: any = new Error(detail);
    error.noRetry = true;
    error.providerFailure = moderated
      ? { code: 'PROVIDER_MODERATION', message: '请求或生成结果被供应商安全检查拒绝，请调整提示词或参考图后重试' }
      : { code: 'PROVIDER_PARAMETERS', message: detail && detail !== status ? `供应商任务失败：${detail}` : '供应商任务失败，请调整提示词或参考图后重试' };
    throw error;
  }
}

export async function pollFluxUntilReady(deps: VideoAdapterDeps, token: string) {
  const deadline = (deps.now ?? Date.now)() + fluxPollTimeoutMs(deps);
  let attempt = 0;
  while (true) {
    if ((deps.now ?? Date.now)() >= deadline) throw providerTimeoutError();
    const payload = await fluxGet(deps, fluxPollUrl(deps.baseUrl, token));
    throwIfFluxFailed(payload);
    if (/^Ready$/i.test(fluxStatus(payload) ?? '')) {
      const sample = fluxSampleUrl(payload);
      if (!sample) throw providerProtocolError('供应商未返回结果地址');
      return sample;
    }
    await (deps.sleep ?? defaultSleep)(pollDelayMs(attempt), deps.signal);
    attempt += 1;
  }
}

export async function testFluxConnection(deps: Pick<VideoAdapterDeps, 'http' | 'headers' | 'baseUrl' | 'timeoutSeconds'>) {
  try {
    const response = await deps.http.request(`${fluxApiRoot(deps.baseUrl)}/get_result?id=0`, {
      method: 'GET',
      headers: fluxHeaders(deps.headers),
      redirectPolicy: 'same-origin',
      signal: AbortSignal.timeout(Math.min(Math.max(deps.timeoutSeconds, 10), 30) * 1000),
    }, MAX_ERROR_BYTES);
    if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key 是否来自 dashboard.bfl.ai，以及 Base URL 是否为 https://api.bfl.ai' };
    return { ok: true, status: response.status };
  } catch {
    return { ok: false, message: '供应商连接失败' };
  }
}

