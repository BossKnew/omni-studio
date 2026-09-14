/**
 * Nano Banana (Gemini native image generation).
 * Speaks POST {root}/models/{model}:generateContent with contents.parts
 * (text and optional inline_data images) and generationConfig.imageConfig.
 * Parses candidates[].content.parts[].inlineData as PNG/JPEG bytes.
 *
 * Text-to-image and reference-image editing are supported.
 * Mask inpainting has no Gemini counterpart and is rejected by the processor.
 */
import { MAX_ERROR_BYTES } from './safe-http.service';
import type { VideoAdapterDeps } from './provider-adapter';
import { gcd } from './resolution';

type Json = Record<string, unknown>;

export function bananaApiRoot(baseUrl: string) {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (/^https:\/\/generativelanguage\.googleapis\.com$/i.test(url)) url += '/v1beta';
  return url.replace(/\/+$/, '');
}

export function bananaHeaders(headers: Record<string, string>, extra?: Record<string, string>) {
  const result: Record<string, string> = { ...headers, ...extra };
  let key = '';
  for (const [name, value] of Object.entries(result)) {
    if (name.toLowerCase() === 'authorization') key = value.replace(/^Bearer\s+/i, '').trim();
  }
  if (key && !Object.keys(result).some((name) => name.toLowerCase() === 'x-goog-api-key')) {
    result['x-goog-api-key'] = key;
  }
  return result;
}

/** Maps a stored WxH size (or an already-canonical ratio) to Gemini aspectRatio. */
export function bananaAspectRatio(size: unknown) {
  if (typeof size === 'string' && /^\d{1,4}:\d{1,4}$/.test(size.trim())) return size.trim();
  const match = /^(\d{1,5})[xX](\d{1,5})$/.exec(String(size ?? '').trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** Maps WxH / quality / tier labels onto Gemini imageSize (512, 1K, 2K, 4K). */
export function bananaImageSize(size: unknown, quality?: unknown) {
  if (typeof quality === 'string') {
    const value = quality.trim();
    if (/^512$/i.test(value) || /^0\.5k$/i.test(value)) return '512';
    if (/^(1k|2k|4k)$/i.test(value)) return value.toUpperCase();
  }
  const match = /^(\d{1,5})[xX](\d{1,5})$/.exec(String(size ?? '').trim());
  if (!match) return undefined;
  const edge = Math.max(Number(match[1]), Number(match[2]));
  if (edge <= 768) return '512';
  if (edge <= 1400) return '1K';
  if (edge <= 2048) return '2K';
  return '4K';
}

export function bananaRequestBody(
  prompt: string,
  parameters: { size?: unknown; quality?: unknown },
  images: Array<{ mimeType: string; data: string }> = [],
) {
  const parts: Json[] = images.map((image) => ({
    inline_data: { mime_type: image.mimeType, data: image.data },
  }));
  parts.push({ text: prompt });
  const generationConfig: Json = { responseModalities: ['TEXT', 'IMAGE'] };
  const imageConfig: Json = {};
  const aspectRatio = bananaAspectRatio(parameters.size);
  const imageSize = bananaImageSize(parameters.size, parameters.quality);
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
  return { contents: [{ role: 'user', parts }], generationConfig };
}

function geminiErrorMessage(body?: Buffer) {
  if (!body?.length) return undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : undefined;
    const error = object?.error && typeof object.error === 'object' && !Array.isArray(object.error) ? object.error as Json : undefined;
    const message = error?.message;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
  } catch { return undefined; }
}

export function bananaImageFailure(status: number, body?: Buffer) {
  const message = geminiErrorMessage(body);
  if ((status === 400 || status === 422) && /safety|blocked|prohibited|moderation/i.test(message ?? '')) {
    return { code: 'PROVIDER_MODERATION', message: '请求或生成结果被供应商安全检查拒绝，请调整提示词或参考图后重试' };
  }
  if (status === 400 || status === 422) {
    return { code: 'PROVIDER_PARAMETERS', message: message ? `供应商拒绝了图片或模型参数：${message}` : '供应商拒绝了图片或模型参数，请管理员检查模型 ID、参考图、比例和分辨率' };
  }
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH', message: '供应商认证失败，请检查 API Key 是否来自 Google AI Studio，以及 Base URL 是否为 https://generativelanguage.googleapis.com/v1beta' };
  if (status === 404) {
    return { code: 'PROVIDER_NOT_FOUND', message: message
      ? `供应商接口或模型不存在：${message}`
      : '供应商接口或模型不存在。Base URL 填 https://generativelanguage.googleapis.com/v1beta，模型 ID 例如 gemini-3.1-flash-image、gemini-3-pro-image、gemini-2.5-flash-image。' };
  }
  if (status === 429) return { code: 'PROVIDER_LIMIT', message: '供应商限流或账户额度不足，请稍后重试' };
  return { code: 'PROVIDER_UNAVAILABLE', message: message ? `供应商服务暂时不可用：${message}` : '供应商服务暂时不可用，请稍后重试' };
}

export async function testBananaConnection(deps: Pick<VideoAdapterDeps, 'http' | 'headers' | 'baseUrl' | 'timeoutSeconds'>) {
  try {
    const response = await deps.http.request(`${bananaApiRoot(deps.baseUrl)}/models`, {
      method: 'GET',
      headers: bananaHeaders(deps.headers),
      redirectPolicy: 'same-origin',
      signal: AbortSignal.timeout(Math.min(Math.max(deps.timeoutSeconds, 10), 30) * 1000),
    }, MAX_ERROR_BYTES);
    if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, message: '供应商认证失败，请检查 API Key 是否来自 Google AI Studio，以及 Base URL 是否为 https://generativelanguage.googleapis.com/v1beta' };
    if (response.status === 404) return { ok: false, status: response.status, message: '模型列表接口不存在，请检查 Base URL 是否为 https://generativelanguage.googleapis.com/v1beta' };
    return { ok: true, status: response.status };
  } catch {
    return { ok: false, message: '供应商连接失败' };
  }
}
