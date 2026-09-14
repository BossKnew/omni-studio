export type UserRole = 'USER' | 'ADMIN';

export type StudioUser = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  mustChangePwd: boolean;
  mfaEnabled: boolean;
  mfaRequired: boolean;
};

export type SecurityUser = Pick<StudioUser, 'role' | 'mfaEnabled' | 'mfaRequired'>;

export type UsagePolicy = {
  groupId: string;
  groupName: string;
  window: string;
  points: number;
  used: number;
  remaining: number;
  resetAt: string | null;
  retryAfterSeconds: number;
};

export type UsageSnapshot = {
  storageBytes: string;
  storageQuotaBytes: string;
  libraryAssetCount?: number;
  policies: UsagePolicy[];
};
export type CursorPage<T> = { items: T[]; nextCursor: string | null; total?: number };

export type MediaKind = 'IMAGE' | 'VIDEO';
export type GenerationMode = 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'INPAINT' | 'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO' | 'FIRST_LAST_FRAME_TO_VIDEO';
export type FrameRole = 'first' | 'last';
export type GenerationStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type ResolutionTier = { label: string; shortEdge: number };

export type StudioModel = {
  id: string;
  displayName: string;
  mediaKind: MediaKind;
  supportsGeneration: boolean;
  supportsEdit: boolean;
  supportsInpaint: boolean;
  supportsFirstLastFrame: boolean;
  allowedSizes: string[];
  resolutionTiers: ResolutionTier[];
  allowedRatios: string[];
  allowedQualities: string[];
  allowedDurations: number[];
  maxImages: number;
  maxInputImages: number;
  costPerUnit: number;
  pointMultipliers?: Record<string, number> | null;
  defaults: { size?: string; quality?: string; count?: number; durationSeconds?: number };
};

export type ConversationSummary = { id: string; title: string };

export type StudioGroup = { id: string; name: string };
export type StudioTeam = { id: string; name: string };

export type Asset = {
  id: string;
  role: 'UPLOAD' | 'OUTPUT' | 'MASK';
  mediaKind: MediaKind;
  durationMs?: number | null;
  contentUrl: string;
  thumbnailUrl?: string | null;
  thumbnailWidth?: number | null;
  thumbnailHeight?: number | null;
  width: number | null;
  height: number | null;
  mimeType?: string;
  originalName?: string | null;
  sizeBytes?: string;
  note: string | null;
  generationPrompt?: string | null;
  visibility?: 'owned' | 'shared';
  sharedTeamIds?: string[];
  shareId?: string;
  sharedAt?: string;
  team?: StudioTeam;
  sharedBy?: { displayName: string };
  canUnshare?: boolean;
  deletedAt?: string | null;
  purgeAfter?: string | null;
};

export type JobAsset = Omit<Asset, 'contentUrl'> & { contentUrl: string | null; deleted?: boolean };

export type GenerationJob = {
  id: string;
  conversationId?: string;
  status: GenerationStatus;
  mode: GenerationMode;
  mediaKind: MediaKind;
  prompt: string;
  errorMessage: string | null;
  parameters: { count?: number; durationSeconds?: number; size?: string; quality?: string };
  modelSnapshot: { displayName: string };
  assets: JobAsset[];
};

export type ConversationDetail = { id: string; title: string; jobs: GenerationJob[]; nextJobCursor?: string | null };
export type GenerationCreated = { id: string; conversationId: string; status: GenerationStatus };

export type ReferenceSelection =
  | { key: string; kind: 'asset'; asset: Asset; frameRole?: FrameRole }
  | { key: string; kind: 'file'; file: File; frameRole?: FrameRole };

export type GenerationReuse = {
  prompt: string;
  mode: GenerationMode;
  modelId: string | null;
  modelDisplayName: string;
  size: string | null;
  quality: string | null;
  count: number;
  durationSeconds?: number | null;
  sourceAssets: Asset[];
  requiresMaskRedraw: boolean;
  stylePresetId?: string | null;
};

export type PromptEntry = {
  id: string;
  prompt: string;
  isFavorite: boolean;
  usageCount: number;
  lastUsedAt: string;
  createdAt: string;
};

export type DownloadAsset = {
  id: string;
  mimeType?: string;
  downloadName: string;
  contentUrl: string;
  thumbnailUrl?: string | null;
};

export function getActiveGenerationJobs(conversation: ConversationDetail): GenerationJob[] {
  return conversation.jobs.filter((job) => job.status === 'QUEUED' || job.status === 'RUNNING');
}

export function isVideoGenerationMode(mode: GenerationMode) {
  return mode === 'TEXT_TO_VIDEO' || mode === 'IMAGE_TO_VIDEO' || mode === 'FIRST_LAST_FRAME_TO_VIDEO';
}

export function assignFrameRoles(references: ReferenceSelection[]): ReferenceSelection[] {
  let first = references.find((item) => item.frameRole === 'first');
  let last = references.find((item) => item.frameRole === 'last');
  for (const item of references) {
    if (item.frameRole === 'first' || item.frameRole === 'last') continue;
    if (!first) first = item;
    else if (!last && item.key !== first.key) last = item;
  }
  const next: ReferenceSelection[] = [];
  if (first) next.push({ ...first, frameRole: 'first' });
  if (last && last.key !== first?.key) next.push({ ...last, frameRole: 'last' });
  return next;
}

export function firstLastReferences(references: ReferenceSelection[]) {
  const assigned = assignFrameRoles(references);
  return {
    first: assigned.find((item) => item.frameRole === 'first'),
    last: assigned.find((item) => item.frameRole === 'last'),
  };
}

export function sameReferenceSelection(left: ReferenceSelection[], right: ReferenceSelection[]) {
  return left.length === right.length && left.every((item, index) => item.key === right[index].key && item.frameRole === right[index].frameRole);
}
