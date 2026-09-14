export const UPLOAD_IMAGE_SETTING_KEY = 'upload_image';
export const DEFAULT_UPLOAD_MAX_LONG_EDGE = 4096;
export const MIN_UPLOAD_MAX_LONG_EDGE = 1024;
export const MAX_UPLOAD_MAX_LONG_EDGE = 8192;
export const UPLOAD_MAX_LONG_EDGE_STEP = 256;

export type UploadImagePolicy = { maxLongEdge: number };

const INVALID_MAX_LONG_EDGE = '上传图片最长边必须是 1024 到 8192 之间、步长为 256 的整数';
const INVALID_POLICY = '上传图片策略格式无效';

export function parseUploadMaxLongEdge(value: unknown) {
  const edge = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(edge) || edge < MIN_UPLOAD_MAX_LONG_EDGE || edge > MAX_UPLOAD_MAX_LONG_EDGE || edge % UPLOAD_MAX_LONG_EDGE_STEP !== 0) {
    throw new Error(INVALID_MAX_LONG_EDGE);
  }
  return edge;
}

export function parseUploadImagePolicy(value: unknown): UploadImagePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_POLICY);
  return { maxLongEdge: parseUploadMaxLongEdge((value as { maxLongEdge?: unknown }).maxLongEdge) };
}

export function uploadImagePolicyFromSetting(value: unknown): UploadImagePolicy {
  try { return parseUploadImagePolicy(value); }
  catch { return { maxLongEdge: DEFAULT_UPLOAD_MAX_LONG_EDGE }; }
}
