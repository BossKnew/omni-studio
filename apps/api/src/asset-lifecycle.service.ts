import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { AssetContentCache } from './asset-content-cache';
import { PrismaService } from './prisma.service';
import { QuotaService } from './quota.service';
import { StorageService } from './storage.service';
import { runsBackgroundMaintenance } from './process-role';
import { trashRetentionFromSetting } from './trash-retention';

type ImageThumbnail = { path: string; sizeBytes: bigint; mimeType: string; width: number; height: number };
type NormalizedImage = { path: string; sizeBytes: bigint; mimeType: string; width: number; height: number; thumbnail?: ImageThumbnail };
type NormalizedVideo = { path: string; sizeBytes: bigint; mimeType: string; width: number | null; height: number | null; durationMs: number | null };
const trashSelect = {
  id: true,
  userId: true,
  objectKey: true,
  sizeBytes: true,
  thumbnail: { select: { id: true, objectKey: true, deletedAt: true } },
} as const;
type TrashItem = {
  id: string;
  userId: string;
  objectKey: string;
  sizeBytes: bigint;
  thumbnail: { id: string; objectKey: string; deletedAt: Date | null } | null;
};

function prismaErrorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
}

const LIBRARY_ROLES = ['UPLOAD', 'OUTPUT'] as const;
const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class AssetLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssetLifecycleService.name);
  private purgeTimer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private quota: QuotaService,
    @Optional() private contentCache?: AssetContentCache,
  ) {}

  async onModuleInit() {
    if (!runsBackgroundMaintenance()) return;
    await this.purgeExpired().catch((error) => this.logger.warn(`trash purge failed: ${error instanceof Error ? error.message : 'unknown'}`));
    this.purgeTimer = setInterval(() => void this.purgeExpired().catch((error) => this.logger.warn(`trash purge failed: ${error instanceof Error ? error.message : 'unknown'}`)), TRASH_PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  onModuleDestroy() { clearInterval(this.purgeTimer); }

  async currentTrashRetention() {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'trash_retention' } });
    return trashRetentionFromSetting(row?.value);
  }

  async persistNormalized(input: {
    userId: string;
    role: 'UPLOAD' | 'MASK' | 'OUTPUT';
    image: NormalizedImage;
    jobId?: string;
    originalName?: string;
  }) {
    let contentHash: string | undefined;
    if (input.role === 'UPLOAD' || input.role === 'OUTPUT') {
      try {
        contentHash = await this.storage.hashStaged(input.image.path);
        if (input.role === 'UPLOAD') {
          const duplicate = await this.findDuplicateUpload(input.userId, input.image, contentHash);
          if (duplicate) {
            await Promise.all([
              this.storage.deleteStaged(input.image.path),
              input.image.thumbnail ? this.storage.deleteStaged(input.image.thumbnail.path) : Promise.resolve(),
            ]);
            return duplicate;
          }
        }
      } catch (error) {
        await Promise.all([
          this.storage.deleteStaged(input.image.path).catch(() => undefined),
          input.image.thumbnail ? this.storage.deleteStaged(input.image.thumbnail.path).catch(() => undefined) : Promise.resolve(),
        ]);
        throw error;
      }
    }
    if (input.role === 'MASK' && input.image.thumbnail) await this.storage.deleteStaged(input.image.thumbnail.path).catch(() => undefined);
    let thumbnail: ImageThumbnail | undefined = input.role === 'MASK' ? undefined : input.image.thumbnail;
    try { if (!thumbnail && input.role !== 'MASK') thumbnail = await this.storage.createThumbnailFile(input.image.path); }
    catch (error) { await this.storage.deleteStaged(input.image.path).catch(() => undefined); throw error; }
    const thumbnailHash = thumbnail ? await this.storage.hashStaged(thumbnail.path).catch(() => undefined) : undefined;
    try { await this.quota.reserveStorage(input.userId, input.image.sizeBytes); }
    catch (error) {
      await Promise.all([this.storage.deleteStaged(input.image.path), thumbnail ? this.storage.deleteStaged(thumbnail.path) : Promise.resolve()]);
      throw error;
    }

    let stored: { objectKey: string; sizeBytes: bigint } | undefined;
    let storedThumbnail: { objectKey: string; sizeBytes: bigint } | undefined;
    try {
      stored = await this.storage.saveStaged(input.userId, input.image.path, input.image.mimeType);
      if (thumbnail) storedThumbnail = await this.storage.saveStaged(input.userId, thumbnail.path, thumbnail.mimeType);
      return await this.prisma.$transaction(async (tx) => {
        const asset = await tx.asset.create({ data: {
          userId: input.userId,
          jobId: input.jobId,
          role: input.role,
          mediaKind: 'IMAGE',
          objectKey: stored!.objectKey,
          mimeType: input.image.mimeType,
          sizeBytes: stored!.sizeBytes,
          width: input.image.width,
          height: input.image.height,
          originalName: input.originalName,
          contentHash,
        }});
        const thumbnailAsset = storedThumbnail && thumbnail ? await tx.asset.create({ data: {
          userId: input.userId,
          jobId: input.jobId,
          role: 'THUMBNAIL',
          objectKey: storedThumbnail.objectKey,
          mimeType: thumbnail.mimeType,
          sizeBytes: storedThumbnail.sizeBytes,
          width: thumbnail.width,
          height: thumbnail.height,
          contentHash: thumbnailHash,
          thumbnailForId: asset.id,
        }}) : null;
        return { ...asset, thumbnail: thumbnailAsset ? { id: thumbnailAsset.id, deletedAt: thumbnailAsset.deletedAt } : null };
      });
    } catch (error) {
      await Promise.all([
        this.storage.deleteStaged(input.image.path).catch(() => undefined),
        thumbnail ? this.storage.deleteStaged(thumbnail.path).catch(() => undefined) : Promise.resolve(),
        stored ? this.storage.delete(stored.objectKey).catch(() => undefined) : Promise.resolve(),
        storedThumbnail ? this.storage.delete(storedThumbnail.objectKey).catch(() => undefined) : Promise.resolve(),
      ]);
      await this.quota.releaseStorage(input.userId, input.image.sizeBytes);
      if (contentHash && prismaErrorCode(error) === 'P2002') {
        const duplicate = await this.activeUploadByHash(input.userId, contentHash);
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  private activeUploadByHash(userId: string, contentHash: string) {
    return this.prisma.asset.findFirst({
      where: { userId, role: 'UPLOAD', contentHash, deletedAt: null },
      include: { thumbnail: { select: { id: true, deletedAt: true } } },
    });
  }

  private async findDuplicateUpload(userId: string, image: NormalizedImage, contentHash: string) {
    const indexed = await this.activeUploadByHash(userId, contentHash);
    if (indexed) return indexed;

    const legacyCandidates = await this.prisma.asset.findMany({
      where: {
        userId,
        role: 'UPLOAD',
        deletedAt: null,
        contentHash: null,
        sizeBytes: image.sizeBytes,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
      },
      select: { id: true, objectKey: true },
    });
    for (const candidate of legacyCandidates) {
      let existingHash: string;
      try { existingHash = await this.storage.hashObject(candidate.objectKey); }
      catch { continue; }
      if (existingHash !== contentHash) continue;
      try {
        return await this.prisma.asset.update({
          where: { id: candidate.id },
          data: { contentHash },
          include: { thumbnail: { select: { id: true, deletedAt: true } } },
        });
      } catch (error) {
        if (prismaErrorCode(error) === 'P2025') continue;
        if (prismaErrorCode(error) === 'P2002') {
          const winner = await this.activeUploadByHash(userId, contentHash);
          if (winner) return winner;
        }
        throw error;
      }
    }
    return null;
  }

  async persistVideo(input: { userId: string; jobId: string; video: NormalizedVideo; originalName?: string }) {
    let thumbnail: Awaited<ReturnType<StorageService['createThumbnailFile']>> | undefined;
    try { thumbnail = await this.storage.createVideoThumbnailFile(input.video.path); }
    catch { thumbnail = undefined; }
    const contentHash = await this.storage.hashStaged(input.video.path).catch(() => undefined);
    const thumbnailHash = thumbnail ? await this.storage.hashStaged(thumbnail.path).catch(() => undefined) : undefined;
    try { await this.quota.reserveStorage(input.userId, input.video.sizeBytes); }
    catch (error) {
      await Promise.all([thumbnail ? this.storage.deleteStaged(thumbnail.path) : Promise.resolve()]);
      throw error;
    }
    let stored: { objectKey: string; sizeBytes: bigint } | undefined;
    let storedThumbnail: { objectKey: string; sizeBytes: bigint } | undefined;
    try {
      stored = await this.storage.saveStaged(input.userId, input.video.path, input.video.mimeType);
      if (thumbnail) storedThumbnail = await this.storage.saveStaged(input.userId, thumbnail.path, thumbnail.mimeType);
      return await this.prisma.$transaction(async (tx) => {
        const asset = await tx.asset.create({ data: {
          userId: input.userId,
          jobId: input.jobId,
          role: 'OUTPUT',
          mediaKind: 'VIDEO',
          objectKey: stored!.objectKey,
          mimeType: input.video.mimeType,
          sizeBytes: stored!.sizeBytes,
          width: input.video.width,
          height: input.video.height,
          durationMs: input.video.durationMs,
          originalName: input.originalName,
          contentHash,
        }});
        const thumbnailAsset = storedThumbnail && thumbnail ? await tx.asset.create({ data: {
          userId: input.userId,
          jobId: input.jobId,
          role: 'THUMBNAIL',
          mediaKind: 'IMAGE',
          objectKey: storedThumbnail.objectKey,
          mimeType: thumbnail.mimeType,
          sizeBytes: storedThumbnail.sizeBytes,
          width: thumbnail.width,
          height: thumbnail.height,
          contentHash: thumbnailHash,
          thumbnailForId: asset.id,
        }}) : null;
        return { ...asset, thumbnail: thumbnailAsset ? { id: thumbnailAsset.id, deletedAt: thumbnailAsset.deletedAt } : null };
      });
    } catch (error) {
      await Promise.all([
        thumbnail ? this.storage.deleteStaged(thumbnail.path).catch(() => undefined) : Promise.resolve(),
        stored ? this.storage.delete(stored.objectKey).catch(() => undefined) : Promise.resolve(),
        storedThumbnail ? this.storage.delete(storedThumbnail.objectKey).catch(() => undefined) : Promise.resolve(),
      ]);
      await this.quota.releaseStorage(input.userId, input.video.sizeBytes);
      throw error;
    }
  }

  async remove(userId: string, id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id, userId, deletedAt: null, role: { in: [...LIBRARY_ROLES] } },
      select: { id: true, thumbnail: { select: { id: true } } },
    });
    if (!asset) return null;
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + (await this.currentTrashRetention()).seconds * 1000);
    const data = { deletedAt: now, purgeAfter, purgedAt: null };
    await this.prisma.$transaction([
      this.prisma.asset.update({ where: { id: asset.id }, data }),
      ...(asset.thumbnail ? [this.prisma.asset.update({ where: { id: asset.thumbnail.id }, data })] : []),
    ]);
    await this.forgetContent([asset.id, asset.thumbnail?.id]);
    return asset;
  }

  async restore(userId: string, id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id, userId, deletedAt: { not: null }, purgedAt: null, role: { in: [...LIBRARY_ROLES] } },
      select: { id: true, thumbnail: { select: { id: true } } },
    });
    if (!asset) return null;
    const data = { deletedAt: null, purgeAfter: null, purgedAt: null };
    await this.prisma.$transaction([
      this.prisma.asset.update({ where: { id: asset.id }, data }),
      ...(asset.thumbnail ? [this.prisma.asset.update({ where: { id: asset.thumbnail.id }, data })] : []),
    ]);
    await this.forgetContent([asset.id, asset.thumbnail?.id]);
    return asset;
  }

  async purge(userId: string, id: string) {
    const asset = await this.findTrashItem(userId, id);
    if (!asset) return null;
    await this.purgeOne(asset);
    return asset;
  }

  async emptyTrash(userId: string) {
    let purged = 0;
    for (;;) {
      const batch = await this.prisma.asset.findMany({
        where: { userId, deletedAt: { not: null }, purgedAt: null, role: { in: [...LIBRARY_ROLES] } },
        select: trashSelect,
        take: 50,
      });
      if (!batch.length) return purged;
      for (const asset of batch) {
        if (await this.purgeOne(asset)) purged += 1;
      }
    }
  }

  async purgeExpired() {
    let purged = 0;
    for (;;) {
      const batch = await this.prisma.asset.findMany({
        where: { deletedAt: { not: null }, purgedAt: null, purgeAfter: { lte: new Date() }, role: { in: [...LIBRARY_ROLES] } },
        select: trashSelect,
        take: 50,
      });
      if (!batch.length) return purged;
      for (const asset of batch) {
        if (await this.purgeOne(asset)) purged += 1;
      }
    }
  }

  private findTrashItem(userId: string, id: string) {
    return this.prisma.asset.findFirst({
      where: { id, userId, deletedAt: { not: null }, purgedAt: null, role: { in: [...LIBRARY_ROLES] } },
      select: trashSelect,
    });
  }

  private async purgeOne(asset: TrashItem) {
    const now = new Date();
    const claimed = await this.prisma.$transaction(async (tx) => {
      const parent = await tx.asset.updateMany({ where: { id: asset.id, deletedAt: { not: null }, purgedAt: null }, data: { purgedAt: now } });
      if (!parent.count) return false;
      if (asset.thumbnail) await tx.asset.updateMany({ where: { id: asset.thumbnail.id, purgedAt: null }, data: { purgedAt: now, deletedAt: asset.thumbnail.deletedAt ?? now } });
      return true;
    });
    if (!claimed) return false;
    await this.storage.deleteMany([asset.objectKey, ...(asset.thumbnail ? [asset.thumbnail.objectKey] : [])]);
    await this.quota.releaseStorage(asset.userId, asset.sizeBytes);
    await this.forgetContent([asset.id, asset.thumbnail?.id]);
    return true;
  }

  async removeJobOutputs(userId: string, jobId: string) {
    const assets = await this.prisma.asset.findMany({ where: { jobId, role: { in: ['OUTPUT', 'THUMBNAIL'] } }, select: { id: true, objectKey: true, role: true, sizeBytes: true, deletedAt: true, purgedAt: true } });
    await this.storage.deleteMany(assets.map(({ objectKey }) => objectKey));
    await this.prisma.asset.deleteMany({ where: { jobId, role: { in: ['OUTPUT', 'THUMBNAIL'] } } });
    const bytes = assets.filter((asset) => asset.role === 'OUTPUT' && !asset.purgedAt).reduce((sum, asset) => sum + asset.sizeBytes, 0n);
    if (bytes) await this.quota.releaseStorage(userId, bytes);
    await this.forgetContent(assets.map((asset) => asset.id));
    return bytes;
  }

  async removeMask(userId: string, id: string) {
    const mask = await this.prisma.asset.findFirst({
      where: { id, userId, role: 'MASK' },
      select: { id: true, objectKey: true, sizeBytes: true },
    });
    if (!mask) return false;
    await this.storage.deleteMany([mask.objectKey]);
    await this.prisma.asset.delete({ where: { id: mask.id } });
    await this.quota.releaseStorage(userId, mask.sizeBytes);
    await this.forgetContent([mask.id]);
    return true;
  }

  private forgetContent(ids: Array<string | null | undefined>) {
    return this.contentCache?.invalidate(ids) ?? Promise.resolve();
  }
}
