import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from './common';
import { PrismaService } from './prisma.service';
import { StorageService } from './storage.service';
import { QuotaService } from './quota.service';
import { parseBody } from './validation';
import { z } from 'zod';
import { generationJobSelect, serializeGenerationJob, sourceAssetIdsFromParameters } from './generation-response';
import { cursorWhere, decodeCursor, encodeCursor, pageLimit } from './pagination';
import { ACTIVE_JOB_STATUSES } from './domain-constants';
import { serializeAssetLinks } from './asset-response';
import { findSourceIdsUsedInOtherConversations } from './source-asset-refs';

const titleSchema = z.object({ title: z.string().trim().min(1).max(80) }).strict();

@Controller('conversations')
export class ConversationsController {
  constructor(private prisma: PrismaService, private storage: StorageService, private quota: QuotaService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('limit') rawLimit?: string, @Query('cursor') rawCursor?: string) {
    const limit = pageLimit(rawLimit, 30);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.prisma.conversation.findMany({
      where: { userId: user.id, ...cursorWhere('updatedAt', cursor) },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last.updatedAt, last.id) : null };
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() raw: unknown) {
    const body = raw === undefined || (typeof raw === 'object' && raw !== null && !Object.keys(raw).length) ? { title: '新创作' } : parseBody(titleSchema, raw);
    const title = body.title;
    return this.prisma.conversation.create({ data: { userId: user.id, title } });
  }

  @Get(':id/output-assets')
  async outputAssets(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const conversation = await this.prisma.conversation.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!conversation) throw new NotFoundException();
    const assets = await this.prisma.asset.findMany({
      where: { userId: user.id, role: 'OUTPUT', deletedAt: null, job: { conversationId: id, userId: user.id } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, mimeType: true, createdAt: true, deletedAt: true, contentHash: true },
    });
    return {
      items: assets.map((asset, index) => ({
        id: asset.id,
        mimeType: asset.mimeType,
        downloadName: `session-${String(index + 1).padStart(4, '0')}${extensionForMime(asset.mimeType)}`,
        ...serializeAssetLinks(asset),
      })),
      total: assets.length,
    };
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Query('jobLimit') rawLimit?: string, @Query('jobCursor') rawCursor?: string) {
    const limit = pageLimit(rawLimit, 20);
    const cursor = decodeCursor(rawCursor);
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId: user.id },
      select: { id: true, title: true, jobs: { where: cursorWhere('createdAt', cursor), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: { ...generationJobSelect, createdAt: true } } },
    });
    if (!conversation) throw new NotFoundException();
    const hasMore = conversation.jobs.length > limit;
    const page = conversation.jobs.slice(0, limit);
    const last = page.at(-1);
    return { id: conversation.id, title: conversation.title, jobs: [...page].reverse().map(serializeGenerationJob), nextJobCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  @Patch(':id')
  async rename(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(titleSchema, raw);
    const result = await this.prisma.conversation.updateMany({ where: { id, userId: user.id }, data: { title: body.title } });
    if (!result.count) throw new NotFoundException();
    return { ok: true };
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId: user.id },
      select: { jobs: { select: { status: true, parameters: true, assets: { select: { id: true, objectKey: true, sizeBytes: true, deletedAt: true, purgedAt: true, role: true } } } } },
    });
    if (!conversation) throw new NotFoundException();
    if (conversation.jobs.some((job) => ACTIVE_JOB_STATUSES.includes(job.status as typeof ACTIVE_JOB_STATUSES[number]))) throw new ConflictException('会话仍有活动任务，暂时不能删除');
    const referencedSourceIds = [...new Set(conversation.jobs.flatMap((job) => sourceAssetIdsFromParameters(job.parameters)))];
    const uploadedSources = referencedSourceIds.length ? await this.prisma.asset.findMany({
      where: { id: { in: referencedSourceIds }, userId: user.id, role: 'UPLOAD' },
      select: { id: true, objectKey: true, sizeBytes: true, deletedAt: true, purgedAt: true, role: true, shares: { select: { id: true }, take: 1 }, thumbnail: { select: { id: true, objectKey: true, sizeBytes: true, deletedAt: true, purgedAt: true, role: true } } },
    }) : [];
    const sharedSourceIds = await findSourceIdsUsedInOtherConversations(
      this.prisma,
      user.id,
      id,
      uploadedSources.map((asset) => asset.id),
    );
    const exclusiveUploads = uploadedSources.filter((asset) => !sharedSourceIds.has(asset.id) && !asset.shares?.length);
    const assets = [
      ...conversation.jobs.flatMap((job) => job.assets),
      ...exclusiveUploads.flatMap(({ thumbnail, ...asset }) => [asset, ...(thumbnail ? [thumbnail] : [])]),
    ];
    const assetIds = assets.map((asset) => asset.id);
    const deletedAssetIds = assets.filter((asset) => !asset.purgedAt && (asset.role === 'UPLOAD' || asset.role === 'OUTPUT')).map((asset) => asset.id);
    await this.storage.deleteMany(assets.map(({ objectKey }) => objectKey));
    const bytes = assets.filter((asset) => !asset.purgedAt && asset.role !== 'THUMBNAIL').reduce((sum, asset) => sum + asset.sizeBytes, 0n);
    await this.prisma.$transaction(async (transaction) => {
      if (assetIds.length) await transaction.asset.deleteMany({ where: { id: { in: assetIds } } });
      await transaction.conversation.delete({ where: { id } });
    });
    if (bytes) await this.quota.releaseStorage(user.id, bytes);
    return { ok: true, deletedAssetIds };
  }
}

function extensionForMime(mimeType: string) {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'video/mp4') return '.mp4';
  return '.png';
}
