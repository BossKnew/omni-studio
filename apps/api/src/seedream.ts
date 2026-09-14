/**
 * Seedream (ByteDance / Volcengine Ark) image adapter.
 * Speaks POST {root}/images/generations with OpenAI-shaped JSON:
 *   { model, prompt, size, watermark, image? }
 * Text-to-image and reference-image editing share the same endpoint.
 * Mask inpainting has no Ark counterpart and is rejected by the processor.
 */
import { MAX_ERROR_BYTES } from './safe-http.service';
import type { VideoAdapterDeps } from './provider-adapter';

type Json = Record<string, unknown>;

export function seedreamApiRoot(baseUrl: string) {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (/^https:\/\/ark\.cn-beijing\.volces\.com$/i.test(url)) url += '/api/v3';
  if (/^https:\/\/ark\.[a-z0-9-]+\.bytepluses\.com$/i.test(url)) url += '/api/v3';
  return url.replace(/\/+$/, '');
}

/** Maps WxH / quality / tier labels onto Seedream size (1K, 2K, 3K, 4K, or exact WxH). */
export function seedreamSize(size: unknown, quality?: unknown) {
  if (typeof quality === 'string') {
    const value = quality.trim();
    if (/^(1k|1\.5k|2k|3k|4k)$/i.test(value)) return value.toUpperCase();
  }
  if (typeof size === 'string') {
    const value = size.trim();
    if (/^(1k|1\.5k|2k|3k|4k)$/i.test(value)) return value.toUpperCase();
    if (/^\d{1,5}x\d{1,5}$/i.test(value)) {
      const match = /^(\d{1,5})x(\d{1,5})$/i.exec(value);
      if (match) {
        const edge = Math.max(Number(match[1]), Number(match[2]));
        if (edge <= 1400) return '1K';
        if (edge <= 2048) return '2K';
        if (edge <= 3072) return '3K';
        return '4K';
      }
    }
  }
  return undefined;
}

export function seedreamRequestBody(
  modelId: string,
  prompt: string,
  parameters: { size?: unknown; quality?: unknown; count?: unknown },
  imageDataUrls: string[] = [],
) {
  const body: Json = {
    model: modelId,
    prompt,
    watermark: false,
  };
  const size = seedreamSize(parameters.size, parameters.quality);
  if (size) body.size = size;
  if (imageDataUrls.length === 1) body.image = imageDataUrls[0];
  else if (imageDataUrls.length > 1) body.image = imageDataUrls;
  const count = typeof parameters.count === 'number' && Number.isInteger(parameters.count) && parameters.count > 1 ? parameters.count : undefined;
  // Official Seedream 4.0 / 4.5 / 5.0-lite use sequential_image_generation=auto
  // plus sequential_image_generation_options.max_images for group output.
  // Seedream 5.0-pro rejects that field entirely (single image only).
  if (count && !/seedream-5-0-pro/i.test(modelId)) {
    body.sequential_image_generation = 'auto';
    body.sequential_image_generation_options = { max_images: count };
  }
  return body;
}

function arkError(body?: Buffer) {
  if (!body?.length) return { code: undefined, message: undefined };
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : undefined;
    const error = object?.error && typeof object.error === 'object' && !Array.isArray(object.error) ? object.error as Json : undefined;
    const code = error?.code ?? object?.code;
    const message = error?.message ?? object?.message;
    return {
      code: typeof code === 'string' && code.trim() ? code.trim() : undefined,
      message: typeof message === 'string' && message.trim() ? message.trim() : undefined,
    };
  } catch { return { code: undefined, message: undefined }; }
}

export function seedreamFailure(status: number, body?: Buffer) {
  const { code, message } = arkError(body);
  if ((status === 400 || status === 422) && /moderation|sensitive|audit|审核|违规/i.test(`${code ?? ''} ${message ?? ''}`)) {
    return { code: 'PROVIDER_MODERATION', message: '请求或生成结果被供应商安全检查拒绝，请调整提示词或参考图后重试' };
  }
  if (status === 400 || status === 422) {
    return { code: 'PROVIDER_PARAMETERS', message: message ? `供应商拒绝了图片或模型参数：${message}` : '供应商拒绝了图片或模型参数，请管理员检查模型 ID、参考图、比例和分辨率' };
  }
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH', message: '供应商认证失败，请检查 API Key 是否来自火山方舟，以及 Base URL 是否包含 /api/v3' };
  if (status === 404) {
    return { code: 'PROVIDER_NOT_FOUND', message: message
      ? `供应商接口或模型不存在：${message}`
      : '供应商接口或模型不存在。Base URL 填 https://ark.cn-beijing.volces.com/api/v3，模型 ID 例如 doubao-seedream-4-0-250828、doubao-seedream-4-5-251128、doubao-seedream-5-0-260128。' };
  }
  if (status === 429) return { code: 'PROVIDER_LIMIT', message: '供应商限流或账户额度不足，请稍后重试' };
  return { code: 'PROVIDER_UNAVAILABLE', message: message ? `供应商服务暂时不可用：${message}` : '供应商服务暂时不可用，请稍后重试' };
}

export async function testSeedreamConnection(deps: Pick<VideoAdapterDeps, 'http' | 'headers' | 'baseUrl' | 'timeoutSeconds'>) {
  try {
    const response = await deps.http.request(`${seedreamApiRoot(deps.baseUrl)}/models`, {
      method: 'GET',
      headers: deps.headers,
      redirectPolicy: 'same-origin',
      signal: AbortSignal.timeout(Math.min(Math.max(deps.timeoutSeconds, 10), 30) * 1000),
    }, MAX_ERROR_BYTES);
    if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key 是否来自火山方舟，以及 Base URL 是否包含 /api/v3' };
    if (response.status === 404) return { ok: false, status: response.status, message: '模型列表接口不存在，请检查 Base URL 是否为 https://ark.cn-beijing.volces.com/api/v3' };
    return { ok: true, status: response.status };
  } catch {
    return { ok: false, message: '供应商连接失败' };
  }
}
