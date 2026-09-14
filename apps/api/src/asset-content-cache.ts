import { Injectable, Optional } from '@nestjs/common';
import type { AssetAccessView } from './asset-access';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

const CACHE_SECONDS = 30;

export type AssetContentRecord = AssetAccessView & {
  id: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: bigint;
  contentHash: string | null;
};

type CachedShare = { teamId: string };
type CachedPayload = {
  id: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: string;
  contentHash: string | null;
  userId: string;
  role: string;
  deletedAt: string | null;
  purgedAt: string | null;
  shares: CachedShare[];
  thumbnailFor: {
    userId: string;
    role: string;
    deletedAt: string | null;
    purgedAt: string | null;
    shares: CachedShare[];
  } | null;
};

const contentSelect = {
  id: true, objectKey: true, mimeType: true, sizeBytes: true, contentHash: true, userId: true, role: true, deletedAt: true, purgedAt: true,
  shares: { select: { teamId: true } },
  thumbnailFor: { select: { userId: true, role: true, deletedAt: true, purgedAt: true, shares: { select: { teamId: true } } } },
} as const;

@Injectable()
export class AssetContentCache {
  private readonly pending = new Map<string, Promise<AssetContentRecord | null>>();

  constructor(private prisma: PrismaService, @Optional() private redis?: RedisService) {}

  async get(id: string) {
    const cached = await this.read(id);
    if (cached) return cached;
    const existing = this.pending.get(id);
    if (existing) return existing;
    let loading!: Promise<AssetContentRecord | null>;
    loading = this.load(id).finally(() => {
      if (this.pending.get(id) === loading) this.pending.delete(id);
    });
    this.pending.set(id, loading);
    return loading;
  }

  async invalidate(ids: Array<string | null | undefined>) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return;
    for (const id of unique) this.pending.delete(id);
    if (!this.redis) return;
    await this.redis.client.del(...unique.map((id) => this.key(id)));
  }

  private async read(id: string) {
    if (!this.redis) return null;
    const raw = await this.redis.client.get(this.key(id));
    if (!raw) return null;
    try { return deserialize(JSON.parse(raw) as CachedPayload); }
    catch {
      await this.redis.client.del(this.key(id));
      return null;
    }
  }

  private async load(id: string) {
    const row = await this.prisma.asset.findFirst({ where: { id, purgedAt: null }, select: contentSelect });
    if (!row) return null;
    const record: AssetContentRecord = {
      ...row,
      contentHash: row.contentHash ?? null,
      shares: row.shares,
      thumbnailFor: row.thumbnailFor,
    };
    if (this.redis) await this.redis.client.set(this.key(id), JSON.stringify(serialize(record)), 'EX', CACHE_SECONDS);
    return record;
  }

  private key(id: string) { return `asset-content:v1:${id}`; }
}

function serialize(asset: AssetContentRecord): CachedPayload {
  return {
    id: asset.id,
    objectKey: asset.objectKey,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes.toString(),
    contentHash: asset.contentHash,
    userId: asset.userId,
    role: asset.role,
    deletedAt: asset.deletedAt?.toISOString() ?? null,
    purgedAt: asset.purgedAt?.toISOString() ?? null,
    shares: asset.shares ?? [],
    thumbnailFor: asset.thumbnailFor ? {
      userId: asset.thumbnailFor.userId,
      role: asset.thumbnailFor.role,
      deletedAt: asset.thumbnailFor.deletedAt?.toISOString() ?? null,
      purgedAt: asset.thumbnailFor.purgedAt?.toISOString() ?? null,
      shares: asset.thumbnailFor.shares ?? [],
    } : null,
  };
}

function deserialize(payload: CachedPayload): AssetContentRecord {
  return {
    id: payload.id,
    objectKey: payload.objectKey,
    mimeType: payload.mimeType,
    sizeBytes: BigInt(payload.sizeBytes),
    contentHash: payload.contentHash,
    userId: payload.userId,
    role: payload.role,
    deletedAt: payload.deletedAt ? new Date(payload.deletedAt) : null,
    purgedAt: payload.purgedAt ? new Date(payload.purgedAt) : null,
    shares: payload.shares,
    thumbnailFor: payload.thumbnailFor ? {
      userId: payload.thumbnailFor.userId,
      role: payload.thumbnailFor.role,
      deletedAt: payload.thumbnailFor.deletedAt ? new Date(payload.thumbnailFor.deletedAt) : null,
      purgedAt: payload.thumbnailFor.purgedAt ? new Date(payload.thumbnailFor.purgedAt) : null,
      shares: payload.thumbnailFor.shares,
    } : null,
  };
}
