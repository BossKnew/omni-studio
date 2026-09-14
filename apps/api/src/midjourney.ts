/**
 * Midjourney image adapter for midjourney-proxy-compatible gateways.
 * Midjourney has no official public API; this adapter speaks:
 *   POST {root}/mj/submit/imagine
 *   GET  {root}/mj/task/{id}/fetch
 *
 * Text-to-image and image-prompt editing (base64Array). Mask inpainting is
 * rejected by the processor.
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
import { gcd } from './resolution';

type Json = JsonObject;

export function mjApiRoot(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/mj(?:\/.*)?$/i, '').replace(/\/+$/, '');
}

export function mjHeaders(headers: Record<string, string>, extra?: Record<string, string>) {
  const result: Record<string, string> = { ...headers, ...extra };
  const key = bearerToken(result);
  if (key && !Object.keys(result).some((name) => name.toLowerCase() === 'mj-api-secret')) {
    result['mj-api-secret'] = key;
  }
  return result;
}

/** Maps WxH or an already-canonical ratio onto a Midjourney --ar value. */
export function mjAspect(size: unknown, aspectRatio?: unknown) {
  if (typeof aspectRatio === 'string' && /^\d{1,4}:\d{1,4}$/.test(aspectRatio.trim())) return aspectRatio.trim();
  if (typeof size === 'string' && /^\d{1,4}:\d{1,4}$/.test(size.trim())) return size.trim();
  const match = /^(\d{1,5})[xX×](\d{1,5})$/.exec(String(size ?? '').trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

export function mjVersionFlag(modelId: string) {
  const id = modelId.trim();
  if (!id || /^midjourney$/i.test(id)) return undefined;
  const niji = /^niji[-_ ]?(\d(?:\.\d)?)$/i.exec(id);
  if (niji) return `--niji ${niji[1]}`;
  const version = /^v?(\d(?:\.\d)?)$/i.exec(id);
  if (version) return `--v ${version[1]}`;
  return undefined;
}

export function mjPrompt(prompt: string, modelId: string, parameters: { size?: unknown; aspectRatio?: unknown }) {
  let textPrompt = prompt.trim();
  const ratio = mjAspect(parameters.size, parameters.aspectRatio);
  if (ratio && !/--ar\b/i.test(textPrompt)) textPrompt += ` --ar ${ratio}`;
  const flag = mjVersionFlag(modelId);
  if (flag && !/--(?:v|niji|version)\b/i.test(textPrompt)) textPrompt += ` ${flag}`;
  return textPrompt;
}

export function mjRequestBody(prompt: string, imageDataUrls: string[] = []) {
  const body: Json = { prompt };
  if (imageDataUrls.length) body.base64Array = imageDataUrls.slice(0, 5);
  return body;
}

export function mjTaskId(payload: unknown) {
  const object = jsonObject(payload);
  const data = jsonObject(object?.data);
  return text(object?.result) ?? text(data?.id) ?? text(data?.taskId) ?? text(object?.id);
}

export function mjSubmitOk(payload: unknown) {
  const object = jsonObject(payload);
  const code = object?.code;
  return code === 1 || code === 21 || code === 22 || code === '1' || code === '21' || code === '22';
}

export function mjStatus(payload: unknown) {
  return text(jsonObject(payload)?.status)?.toUpperCase();
}

export function mjImageUrl(payload: unknown) {
  const object = jsonObject(payload);
  return text(object?.imageUrl) ?? text(object?.image_url) ?? text(object?.uri) ?? text(object?.url);
}

function mjErrorMessage(body?: Buffer) {
  if (!body?.length) return undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : undefined;
    const message = object?.description ?? object?.message ?? object?.failReason ?? object?.error;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
  } catch { return undefined; }
}

export function mjFailure(status: number, body?: Buffer) {
  const message = mjErrorMessage(body);
  if ((status === 400 || status === 422) && /moderat|banned|filter|违规|审核/i.test(message ?? '')) {
    return { code: 'PROVIDER_MODERATION', message: '请求或生成结果被供应商安全检查拒绝，请调整提示词或参考图后重试' };
  }
  if (status === 400 || status === 422) {
    return { code: 'PROVIDER_PARAMETERS', message: message ? `供应商拒绝了图片或模型参数：${message}` : '供应商拒绝了图片或模型参数，请管理员检查网关、模型 ID、参考图和比例' };
  }
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH', message: '供应商认证失败，请检查 API Key 以及 Base URL 是否指向兼容 midjourney-proxy 的网关' };
  if (status === 404) {
    return { code: 'PROVIDER_NOT_FOUND', message: message
      ? `供应商接口或模型不存在：${message}`
      : '供应商接口不存在。Base URL 填兼容 midjourney-proxy 的网关根地址（不要带 /mj/submit/imagine）。' };
  }
  if (status === 429) return { code: 'PROVIDER_LIMIT', message: '供应商限流或账户额度不足，请稍后重试' };
  return { code: 'PROVIDER_UNAVAILABLE', message: message ? `供应商服务暂时不可用：${message}` : '供应商服务暂时不可用，请稍后重试' };
}

function throwMjHttp(status: number, body?: Buffer) {
  const error: any = new Error(`供应商返回 ${status}`);
  error.noRetry = status >= 400 && status < 500;
  error.providerFailure = mjFailure(status, body);
  throw error;
}

function abortMs(deps: Pick<VideoAdapterDeps, 'timeoutSeconds' | 'pollTimeoutSeconds'>, kind: 'short' | 'long') {
  const short = Math.min(Math.max(Number(deps.timeoutSeconds) || 180, 10), 3600) * 1000;
  const poll = Math.min(Math.max(Number(deps.pollTimeoutSeconds) || 900, 10), 3600) * 1000;
  return kind === 'long' ? Math.max(short, poll, 120_000) : short;
}

async function mjGet(deps: VideoAdapterDeps, url: string) {
  const response = await deps.http.request(url, {
    method: 'GET',
    headers: mjHeaders(deps.headers),
    redirectPolicy: 'same-origin',
    signal: deps.signal ?? AbortSignal.timeout(abortMs(deps, 'short')),
    timeoutMs: abortMs(deps, 'short'),
  } as any, MAX_ERROR_BYTES);
  if (!response.ok) throwMjHttp(response.status, response.body);
  const payload = parseJsonBody(response.body);
  if (payload === undefined) throw providerProtocolError('供应商返回的 JSON 无法解析');
  return payload;
}

export async function submitMidjourneyImagine(deps: VideoAdapterDeps, body: unknown) {
  const url = `${mjApiRoot(deps.baseUrl)}/mj/submit/imagine`;
  const response = await deps.http.request(url, {
    method: 'POST',
    headers: mjHeaders(deps.headers, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    redirectPolicy: 'same-origin',
    signal: deps.signal ?? AbortSignal.timeout(abortMs(deps, 'long')),
    timeoutMs: abortMs(deps, 'long'),
  } as any, MAX_ERROR_BYTES);
  if (!response.ok) throwMjHttp(response.status, response.body);
  const payload = parseJsonBody(response.body);
  if (!mjSubmitOk(payload)) {
    const detail = mjErrorMessage(response.body) ?? text(jsonObject(payload)?.description);
    const error: any = new Error(detail || '供应商拒绝了图片请求');
    error.noRetry = true;
    error.providerFailure = {
      code: 'PROVIDER_PARAMETERS',
      message: detail ? `供应商拒绝了图片或模型参数：${detail}` : '供应商拒绝了图片或模型参数，请管理员检查网关和提示词',
    };
    throw error;
  }
  const id = mjTaskId(payload);
  if (!id) throw providerProtocolError('供应商未返回任务 ID');
  return id;
}

export async function pollMidjourneyTask(deps: VideoAdapterDeps, taskId: string) {
  const deadline = (deps.now ?? Date.now)() + Math.min(Math.max(Number(deps.pollTimeoutSeconds) || 900, 10), 3600) * 1000;
  const url = `${mjApiRoot(deps.baseUrl)}/mj/task/${encodeURIComponent(taskId)}/fetch`;
  let attempt = 0;
  while (true) {
    if ((deps.now ?? Date.now)() >= deadline) throw providerTimeoutError();
    const payload = await mjGet(deps, url);
    const status = mjStatus(payload);
    if (status === 'SUCCESS' || status === 'SUCCEEDED') {
      const imageUrl = mjImageUrl(payload);
      if (!imageUrl) throw providerProtocolError('供应商未返回图片地址');
      return imageUrl;
    }
    if (status === 'FAILURE' || status === 'FAILED' || status === 'CANCEL' || status === 'CANCELLED' || status === 'CANCELED') {
      const detail = text(jsonObject(payload)?.failReason) ?? text(jsonObject(payload)?.description);
      const error: any = new Error(detail || '供应商图片任务失败');
      error.noRetry = true;
      error.providerFailure = {
        code: /moderat|banned|filter|违规|审核/i.test(detail ?? '') ? 'PROVIDER_MODERATION' : 'PROVIDER_PARAMETERS',
        message: detail ? `供应商图片任务失败：${detail}` : '供应商图片任务失败，请调整提示词或参考图后重试',
      };
      throw error;
    }
    await (deps.sleep ?? defaultSleep)(pollDelayMs(attempt), deps.signal);
    attempt += 1;
  }
}

export async function testMidjourneyConnection(deps: Pick<VideoAdapterDeps, 'http' | 'headers' | 'baseUrl' | 'timeoutSeconds'>) {
  try {
    const response = await deps.http.request(`${mjApiRoot(deps.baseUrl)}/mj/task/0/fetch`, {
      method: 'GET',
      headers: mjHeaders(deps.headers),
      redirectPolicy: 'same-origin',
      signal: AbortSignal.timeout(Math.min(Math.max(deps.timeoutSeconds, 10), 30) * 1000),
    }, MAX_ERROR_BYTES);
    if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key 以及 Base URL 是否指向兼容 midjourney-proxy 的网关' };
    if (response.status === 404) return { ok: false, status: response.status, message: '任务查询接口不存在，请检查 Base URL 是否为兼容 midjourney-proxy 的网关根地址' };
    return { ok: true, status: response.status };
  } catch {
    return { ok: false, message: '供应商连接失败' };
  }
}
