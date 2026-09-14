export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 8192;
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
export const THUMBNAIL_MAX_EDGE = 384;
export const THUMBNAIL_QUALITY = 82;
export const VIDEO_POLL_INTERVAL_MS = 3_000;
export const POLL_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export function pollDelayMs(attempt: number) {
  const index = Number.isFinite(attempt) ? Math.min(Math.max(Math.trunc(attempt), 0), POLL_DELAYS_MS.length - 1) : 0;
  return POLL_DELAYS_MS[index];
}
export const VIDEO_LOCK_DURATION_MS = 75 * 60 * 1000;
export const IMAGE_LOCK_DURATION_MS = VIDEO_LOCK_DURATION_MS;

export const IMAGE_ADAPTER_KIND = 'openai-images';
export const IMAGE_ADAPTER_KINDS = ['openai-images', 'qwen-image', 'nano-banana', 'seedream', 'midjourney', 'flux', 'runway-images'] as const;
export type ImageAdapterKind = (typeof IMAGE_ADAPTER_KINDS)[number];
export const VIDEO_ADAPTER_KINDS = ['openai-videos', 'seedance', 'wan', 'veo', 'minimax', 'runway', 'flux-video'] as const;
export type VideoAdapterKind = (typeof VIDEO_ADAPTER_KINDS)[number];
export const PROVIDER_ADAPTER_KINDS = [...IMAGE_ADAPTER_KINDS, ...VIDEO_ADAPTER_KINDS] as const;
export type ProviderAdapterKind = (typeof PROVIDER_ADAPTER_KINDS)[number];

export const VIDEO_GENERATION_MODES = ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO', 'FIRST_LAST_FRAME_TO_VIDEO'] as const;
export type VideoGenerationMode = (typeof VIDEO_GENERATION_MODES)[number];

export function isVideoAdapterKind(kind: string): kind is VideoAdapterKind {
  return (VIDEO_ADAPTER_KINDS as readonly string[]).includes(kind);
}

export function isVideoGenerationMode(mode: string): mode is VideoGenerationMode {
  return (VIDEO_GENERATION_MODES as readonly string[]).includes(mode);
}

export function mediaKindForAdapter(kind: string): 'IMAGE' | 'VIDEO' {
  return isVideoAdapterKind(kind) ? 'VIDEO' : 'IMAGE';
}

export function isProviderAdapterKind(kind: string): kind is ProviderAdapterKind {
  return (PROVIDER_ADAPTER_KINDS as readonly string[]).includes(kind);
}

export const ACTIVE_JOB_STATUSES = ['QUEUED', 'RUNNING'] as const;
export const TERMINAL_JOB_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

export const GENERATION_QUEUE_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 100,
};

export const SESSION_PREFIX = 'session:v2:';
export const USER_SESSIONS_PREFIX = 'user_sessions:v2:';
