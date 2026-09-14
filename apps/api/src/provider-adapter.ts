/**
 * Stable boundary for remote media providers. Image generation still uses the
 * dedicated Images worker. Video models are selected by Model.adapterKind.
 */
import { IMAGE_ADAPTER_KIND } from './domain-constants';
import type { SafeHttpService } from './safe-http.service';

export type AdapterMediaKind = 'IMAGE' | 'VIDEO';
export type AdapterOperation = 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'INPAINT' | 'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO';

export interface MediaGenerationRequest {
  mediaKind: AdapterMediaKind;
  operation: AdapterOperation;
  upstreamModelId: string;
  prompt: string;
  parameters: Record<string, unknown>;
  inputAssets: Array<{ mimeType: string; bytes: Uint8Array; role: 'SOURCE' | 'MASK' }>;
}

export interface GeneratedMedia {
  mimeType: string;
  bytes?: Uint8Array;
  path?: string;
}

export interface VideoAdapterDeps {
  http: SafeHttpService;
  headers: Record<string, string>;
  baseUrl: string;
  timeoutSeconds: number;
  pollTimeoutSeconds: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  createStagingPath?: (extension?: string) => Promise<string>;
}

export interface MediaGenerationAdapter {
  readonly kind: string;
  readonly mediaKind: AdapterMediaKind;
  createTask(request: MediaGenerationRequest): Promise<string>;
  collect(taskId: string, request: MediaGenerationRequest): Promise<GeneratedMedia[]>;
  testConnection(): Promise<{ ok: boolean; status?: number; message?: string }>;
}

export function normalizeAdapterKind(value: unknown): string {
  const kind = typeof value === 'string' ? value.trim() : '';
  return kind || IMAGE_ADAPTER_KIND;
}

export type JsonObject = Record<string, unknown>;

export function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseJsonBody(body?: Buffer) {
  if (!body?.length) return undefined;
  try { return JSON.parse(body.toString('utf8')); }
  catch { return undefined; }
}

export function bearerToken(headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') return value.replace(/^Bearer\s+/i, '').trim();
  }
  return '';
}

export function providerErrorCode(body?: Buffer) {
  if (!body?.length) return undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const code = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error && typeof parsed.error === 'object'
      ? parsed.error.code
      : undefined;
    return typeof code === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(code) ? code : undefined;
  } catch { return undefined; }
}

export function videoHttpFailure(status: number, providerCode?: string) {
  if (providerCode === 'moderation_blocked') return { code: 'PROVIDER_MODERATION', message: '请求或生成结果被供应商安全检查拒绝，请调整提示词或参考图后重试' };
  if (status === 400 || status === 422) {
    const detail = providerCode ? `（错误代码：${providerCode}）` : '';
    return { code: 'PROVIDER_PARAMETERS', message: `供应商拒绝了视频或模型参数${detail}，请管理员检查模型 ID、比例、时长、分辨率和参考图` };
  }
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH', message: '供应商认证失败，请管理员检查 API Key 和请求头' };
  if (status === 404) return { code: 'PROVIDER_NOT_FOUND', message: '供应商接口或模型不存在，请管理员检查 Base URL 和模型 ID' };
  if (status === 402 || status === 429) return { code: 'PROVIDER_LIMIT', message: '供应商限流或账户额度不足，请稍后重试' };
  return { code: 'PROVIDER_UNAVAILABLE', message: '供应商服务暂时不可用，请稍后重试' };
}

export function providerProtocolError(message: string, failure?: { code: string; message: string }) {
  const error: any = new Error(message);
  error.noRetry = true;
  error.providerFailure = failure ?? { code: 'PROVIDER_RESPONSE', message: '供应商响应格式无效，请管理员检查 Base URL 和适配器类型' };
  return error;
}

export function providerTimeoutError() {
  const error: any = new Error('视频任务等待超时');
  error.noRetry = true;
  error.providerFailure = { code: 'PROVIDER_TIMEOUT', message: '视频生成等待超时，请稍后重试或让管理员提高任务等待超时' };
  return error;
}

export function providerHttpTimeoutError() {
  const error: any = new Error('供应商请求超时');
  error.noRetry = true;
  error.providerFailure = { code: 'PROVIDER_TIMEOUT', message: '供应商请求超时，请稍后重试或让管理员提高生成超时和任务等待超时' };
  return error;
}

export function isAbortTimeoutError(error: unknown) {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current !== 'object') return false;
    const err = current as { name?: string; code?: string; message?: string; cause?: unknown };
    if (err.name === 'TimeoutError') return true;
    if (err.code === 'UND_ERR_HEADERS_TIMEOUT' || err.code === 'UND_ERR_BODY_TIMEOUT') return true;
    if (typeof err.message === 'string' && /aborted due to timeout|headers timeout|body timeout/i.test(err.message)) return true;
    current = err.cause;
  }
  return false;
}

export function isProviderConnectionError(error: unknown) {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current !== 'object') return false;
    const err = current as { providerConnection?: boolean; code?: string; message?: string; cause?: unknown };
    if (err.providerConnection) return true;
    if (err.code === 'UND_ERR_CONNECT_TIMEOUT' || err.code === 'UND_ERR_SOCKET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return true;
    if (typeof err.message === 'string' && /connect timeout|fetch failed|disconnected before secure TLS/i.test(err.message)) return true;
    current = err.cause;
  }
  return false;
}

export function connectionFailureDetail(error: unknown) {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const err = current as { code?: string; message?: string; cause?: unknown };
    if (err.code === 'ECONNRESET' || /disconnected before secure TLS/i.test(err.message ?? '')) return 'TLS 握手被重置';
    if (err.code === 'UND_ERR_CONNECT_TIMEOUT' || err.code === 'ETIMEDOUT') return '连接超时';
    if (err.code === 'ECONNREFUSED') return '连接被拒绝';
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return '域名无法解析';
    if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || /certificate/i.test(err.message ?? '')) return '证书校验失败';
    current = err.cause;
  }
  return undefined;
}

export function providerConnectionError(cause?: unknown) {
  const detail = connectionFailureDetail(cause);
  const error: any = new Error('无法连接供应商');
  error.providerConnection = true;
  error.cause = cause;
  error.providerFailure = {
    code: 'PROVIDER_CONNECTION',
    message: detail
      ? `无法连接供应商（${detail}）。请管理员检查 Base URL、出站网络和 DNS`
      : '无法连接供应商，请管理员检查 Base URL、出站网络和 DNS',
  };
  return error;
}

export function mapProviderRequestError(error: unknown) {
  if (isAbortTimeoutError(error)) return providerHttpTimeoutError();
  if (isProviderConnectionError(error)) return providerConnectionError(error);
  return error;
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function aspectRatioOf(parameters: Record<string, unknown>) {
  return stringParam(parameters, 'aspectRatio') ?? stringParam(parameters, 'size') ?? '';
}

export function durationSecondsOf(parameters: Record<string, unknown>) {
  const value = parameters.durationSeconds;
  return typeof value === 'number' && Number.isInteger(value) ? value : Number(stringParam(parameters, 'duration') ?? 0);
}

export function resolutionOf(parameters: Record<string, unknown>) {
  return stringParam(parameters, 'resolution') ?? stringParam(parameters, 'quality') ?? '';
}

function stringParam(parameters: Record<string, unknown>, key: string) {
  const value = parameters[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
