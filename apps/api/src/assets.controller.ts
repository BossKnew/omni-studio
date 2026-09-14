import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Optional, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { CurrentUser, type AuthUser } from './common';
import { PrismaService } from './prisma.service';
import { StorageService } from './storage.service';
import { UploadAdmissionInterceptor } from './upload-admission.interceptor';
import { parseBody, uuidSchema } from './validation';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { diskStorage } from 'multer';
import { MAX_IMAGE_BYTES } from './domain-constants';
import { mediaStagingDirName } from './process-role';
import { AssetContentCache } from './asset-content-cache';
import { AssetLifecycleService } from './asset-lifecycle.service';
import { cursorWhere, decodeCursor, encodeCursor, pageLimit } from './pagination';
import { assetFilterWhere, parseAssetListQuery } from './asset-list-query';
import { ifNoneMatchHits, mediaCacheControl, mediaEtag, serializeAssetLinks } from './asset-response';
import { canReadAsset, canShareAsset, canUnshareAsset } from './asset-access';
import { UPLOAD_IMAGE_SETTING_KEY, uploadImagePolicyFromSetting } from './upload-image-policy';

const noteSchema = z.object({ note: z.string().max(1000).nullable() }).strict();
const shareSchema = z.object({ teamIds: z.array(uuidSchema).max(100) }).strict();
const shareSelect = { id: true, teamId: true, createdAt: true, team: { select: { id: true, name: true } } } as const;

@Controller()
export class AssetsController {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private lifecycle: AssetLifecycleService,
    @Optional() private contentCache?: AssetContentCache,
  ) {}

  @Post('uploads')
  @UseInterceptors(UploadAdmissionInterceptor, FileInterceptor('file', {
    limits: { fileSize: MAX_IMAGE_BYTES },
    storage: diskStorage({
      destination: (_request, _file, callback) => {
        const directory = resolve(process.env.MEDIA_ROOT ?? resolve(process.cwd(), 'media'), mediaStagingDirName());
        mkdirSync(directory, { recursive: true });
        callback(null, directory);
      },
      filename: (_request, _file, callback) => callback(null, `${randomUUID()}.upload`),
    }),
  }))
  async upload(@CurrentUser() user: AuthUser, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('请选择图片');
    const role = isMaskUpload(body) ? 'MASK' : 'UPLOAD';
    const setting = await this.prisma.systemSetting.findUnique({ where: { key: UPLOAD_IMAGE_SETTING_KEY }, select: { value: true } });
    const { maxLongEdge } = uploadImagePolicyFromSetting(setting?.value);
    let image;
    try { image = await this.storage.normalizeImageFile(file.path, file.mimetype, { thumbnail: role !== 'MASK', maxLongEdge, mask: role === 'MASK' }); }
    catch (error) { throw new BadRequestException((error as Error).message); }
    finally { await this.storage.deleteStaged(file.path); }
    const asset = await this.lifecycle.persistNormalized({
      userId: user.id, role, image,
      originalName: file.originalname.replace(/[\r\n]/g, '').slice(0, 255),
    });
    return this.serializeOwned(asset);
  }

  @Get('assets')
  async list(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown> = {}) {
    const limit = pageLimit(query.limit, 40);
    const cursor = decodeCursor(query.cursor);
    const filterWhere = assetFilterWhere(parseAssetListQuery(query, { allowQ: true }));
    const where = { userId: user.id, AND: [filterWhere, cursorWhere('createdAt', cursor)] };
    const [rows, total] = await Promise.all([this.prisma.asset.findMany({
      where,
      include: { job: { select: { prompt: true } }, thumbnail: { select: { id: true, deletedAt: true, contentHash: true, width: true, height: true } }, shares: { select: { teamId: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }), cursor ? Promise.resolve(undefined) : this.prisma.asset.count({ where: { userId: user.id, ...filterWhere } })]);
    const hasMore = rows.length > limit;
    const assets = rows.slice(0, limit);
    const last = assets.at(-1);
    return { items: assets.map((asset) => this.serializeOwned(asset)), nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null, ...(total === undefined ? {} : { total }) };
  }

  @Get('assets/trash')
  async trash(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown> = {}) {
    const limit = pageLimit(query.limit, 40);
    const cursor = decodeCursor(query.cursor);
    const filterWhere = assetFilterWhere(parseAssetListQuery(query, { allowQ: true }), { trash: true });
    const where = { userId: user.id, AND: [filterWhere, cursorWhere('deletedAt', cursor)] };
    const [rows, total] = await Promise.all([this.prisma.asset.findMany({
      where,
      include: { job: { select: { prompt: true } }, thumbnail: { select: { id: true, deletedAt: true, purgedAt: true, contentHash: true, width: true, height: true } }, shares: { select: { teamId: true } } },
      orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }), cursor ? Promise.resolve(undefined) : this.prisma.asset.count({ where: { userId: user.id, ...filterWhere } })]);
    const hasMore = rows.length > limit;
    const assets = rows.slice(0, limit);
    const last = assets.at(-1);
    return { items: assets.map((asset) => this.serializeOwned(asset, { allowTrash: true })), nextCursor: hasMore && last && last.deletedAt ? encodeCursor(last.deletedAt, last.id) : null, ...(total === undefined ? {} : { total }) };
  }

  @Post('assets/trash/empty')
  async emptyTrash(@CurrentUser() user: AuthUser) {
    const purged = await this.lifecycle.emptyTrash(user.id);
    return { ok: true, purged };
  }

  @Get('assets/shared')
  async shared(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown> = {}) {
    const limit = pageLimit(query.limit, 40);
    const cursor = decodeCursor(query.cursor);
    const filters = parseAssetListQuery(query, { allowQ: false });
    const teamId = parseOptionalTeamId(query.teamId);
    const visibleTeamIds = await this.visibleTeamIds(user, teamId);
    if (!visibleTeamIds.length) return { items: [], nextCursor: null, total: 0 };
    const filterWhere = {
      teamId: { in: visibleTeamIds },
      asset: assetFilterWhere(filters),
    };
    const where = { ...filterWhere, ...cursorWhere('createdAt', cursor) };
    const [rows, total] = await Promise.all([
      this.prisma.assetShare.findMany({
        where,
        include: {
          team: { select: { id: true, name: true } },
          sharedBy: { select: { displayName: true, username: true } },
          asset: { include: { thumbnail: { select: { id: true, deletedAt: true, contentHash: true, width: true, height: true } } } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      cursor ? Promise.resolve(undefined) : this.prisma.assetShare.count({ where: filterWhere }),
    ]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map((row) => this.serializeShared(row, user)), nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null, ...(total === undefined ? {} : { total }) };
  }

  @Get('assets/:id/shares')
  async shares(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const asset = await this.prisma.asset.findFirst({ where: { id, userId: user.id, deletedAt: null }, select: { id: true } });
    if (!asset) throw new NotFoundException();
    const items = await this.prisma.assetShare.findMany({
      where: { assetId: id },
      orderBy: { createdAt: 'asc' },
      select: shareSelect,
    });
    return { items: items.map((item) => ({ id: item.id, teamId: item.teamId, createdAt: item.createdAt, team: item.team })) };
  }

  @Put('assets/:id/shares')
  async replaceShares(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(shareSchema, raw);
    const teamIds = [...new Set(body.teamIds)];
    if (teamIds.length !== body.teamIds.length) throw new BadRequestException('工作团队不能重复');
    const asset = await this.prisma.asset.findFirst({ where: { id, deletedAt: null }, select: { id: true, userId: true, role: true, deletedAt: true } });
    if (!canShareAsset(user, asset)) throw new NotFoundException();
    const allowedTeamIds = user.role === 'ADMIN' ? teamIds : teamIds.filter((teamId) => user.teamIds.includes(teamId));
    if (allowedTeamIds.length !== teamIds.length) throw new BadRequestException('只能分享到你所属的工作团队');
    if (teamIds.length && await this.prisma.workTeam.count({ where: { id: { in: teamIds } } }) !== teamIds.length) throw new BadRequestException('包含不存在的工作团队');

    const current = await this.prisma.assetShare.findMany({ where: { assetId: id }, select: { teamId: true } });
    const currentIds = new Set(current.map(({ teamId }) => teamId));
    const nextIds = new Set(teamIds);
    const added = teamIds.filter((teamId) => !currentIds.has(teamId));
    const removed = current.map(({ teamId }) => teamId).filter((teamId) => !nextIds.has(teamId));

    await this.prisma.$transaction(async (tx) => {
      if (removed.length) await tx.assetShare.deleteMany({ where: { assetId: id, teamId: { in: removed } } });
      if (added.length) await tx.assetShare.createMany({ data: added.map((teamId) => ({ assetId: id, teamId, sharedById: user.id })) });
      if (added.length) await tx.auditLog.create({ data: { actorId: user.id, action: 'asset.shared', targetType: 'asset', targetId: id, metadata: { teamIds: added } } });
      if (removed.length) await tx.auditLog.create({ data: { actorId: user.id, action: 'asset.unshared', targetType: 'asset', targetId: id, metadata: { teamIds: removed } } });
    });

    await this.forgetContent(id);
    const items = await this.prisma.assetShare.findMany({ where: { assetId: id }, orderBy: { createdAt: 'asc' }, select: shareSelect });
    return { items: items.map((item) => ({ id: item.id, teamId: item.teamId, createdAt: item.createdAt, team: item.team })) };
  }

  @Delete('assets/:id/shares/:teamId')
  async unshare(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('teamId', new ParseUUIDPipe({ version: '4' })) teamId: string,
  ) {
    const asset = await this.prisma.asset.findFirst({ where: { id, deletedAt: null }, select: { id: true, userId: true, deletedAt: true } });
    if (!canUnshareAsset(user, asset)) throw new NotFoundException();
    const result = await this.prisma.assetShare.deleteMany({ where: { assetId: id, teamId } });
    if (!result.count) throw new NotFoundException();
    await this.prisma.auditLog.create({ data: { actorId: user.id, action: 'asset.unshared', targetType: 'asset', targetId: id, metadata: { teamIds: [teamId] } } });
    await this.forgetContent(id);
    return { ok: true };
  }

  @Patch('assets/:id')
  async updateNote(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(noteSchema, raw);
    const note = body.note?.trim() ?? '';
    const asset = await this.prisma.asset.findFirst({ where: { id, userId: user.id, deletedAt: null }, select: { id: true } });
    if (!asset) throw new NotFoundException();
    const updated = await this.prisma.asset.update({ where: { id }, data: { note: note || null }, select: { id: true, note: true } });
    return updated;
  }

  @Get('assets/:id/content')
  async content(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Res() response: Response, @Req() request?: Request) {
    const asset = this.contentCache
      ? await this.contentCache.get(id)
      : await this.prisma.asset.findFirst({
        where: { id, purgedAt: null },
        select: {
          id: true, objectKey: true, mimeType: true, sizeBytes: true, contentHash: true, userId: true, role: true, deletedAt: true, purgedAt: true,
          shares: { select: { teamId: true } },
          thumbnailFor: { select: { userId: true, role: true, deletedAt: true, purgedAt: true, shares: { select: { teamId: true } } } },
        },
      });
    if (!canReadAsset(user, asset)) throw new NotFoundException();
    const etag = mediaEtag(asset!);
    response.setHeader('Content-Type', asset!.mimeType);
    response.setHeader('Cache-Control', mediaCacheControl(asset!.contentHash));
    response.setHeader('ETag', etag);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Accept-Ranges', 'bytes');
    const size = Number(asset!.sizeBytes);
    const range = parseByteRange(request?.headers?.range, size);
    if (!range && ifNoneMatchHits(request?.headers?.['if-none-match'], etag)) {
      response.status(304).end();
      return;
    }
    const probeRange = Boolean(range && range.end === range.start);
    if (process.env.MEDIA_X_ACCEL_REDIRECT === 'true' && !probeRange) {
      const safeObjectKey = asset!.objectKey.split('/').map(encodeURIComponent).join('/');
      response.setHeader('X-Accel-Redirect', `/_protected_media/${safeObjectKey}`);
      response.end();
      return;
    }
    if (range) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      response.setHeader('Content-Length', String(range.end - range.start + 1));
      const stream = this.storage.createReadStream(asset!.objectKey, range);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
      return;
    }
    response.setHeader('Content-Length', asset!.sizeBytes.toString());
    const stream = this.storage.createReadStream(asset!.objectKey);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }

  @Post('assets/:id/restore')
  async restore(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    if (!await this.lifecycle.restore(user.id, id)) throw new NotFoundException();
    return { ok: true };
  }

  @Post('assets/:id/purge')
  async purge(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    if (!await this.lifecycle.purge(user.id, id)) throw new NotFoundException();
    return { ok: true };
  }

  @Delete('assets/:id')
  async remove(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    if (!await this.lifecycle.remove(user.id, id)) throw new NotFoundException();
    return { ok: true };
  }

  private async forgetContent(assetId: string) {
    if (!this.contentCache) return;
    const thumbnail = await this.prisma.asset.findFirst({ where: { thumbnailForId: assetId }, select: { id: true } });
    await this.contentCache.invalidate([assetId, thumbnail?.id]);
  }

  private async visibleTeamIds(user: AuthUser, teamId?: string) {
    if (user.role === 'ADMIN') {
      if (!teamId) return [];
      return [teamId];
    }
    const memberships = user.teamIds;
    if (teamId) {
      if (!memberships.includes(teamId)) throw new BadRequestException('无权访问该工作团队');
      return [teamId];
    }
    return memberships;
  }

  private serializeOwned<T extends { id: string; objectKey: string; sizeBytes: bigint; deletedAt: Date | null; purgeAfter?: Date | null; purgedAt?: Date | null; note: string | null; contentHash?: string | null; job?: { prompt: string } | null; thumbnail?: { id: string; deletedAt: Date | null; purgedAt?: Date | null; contentHash?: string | null; width?: number | null; height?: number | null } | null; shares?: Array<{ teamId: string }> }>(asset: T, options?: { allowTrash?: boolean }): Record<string, unknown> {
    const { job, thumbnail, contentHash, shares, ...storedAsset } = asset;
    return {
      ...storedAsset,
      note: storedAsset.note ?? null,
      generationPrompt: job?.prompt ?? null,
      visibility: 'owned',
      sharedTeamIds: shares?.map(({ teamId }) => teamId) ?? [],
      sizeBytes: asset.sizeBytes.toString(),
      deletedAt: storedAsset.deletedAt,
      purgeAfter: storedAsset.purgeAfter ?? null,
      ...serializeAssetLinks({ id: asset.id, deletedAt: storedAsset.deletedAt, purgedAt: storedAsset.purgedAt, contentHash, thumbnail }, options),
      objectKey: undefined,
      purgedAt: undefined,
    };
  }

  private serializeShared(row: {
    id: string;
    createdAt: Date;
    team: { id: string; name: string };
    sharedBy: { displayName: string | null; username: string };
    asset: { id: string; userId: string; role: string; mimeType: string; mediaKind?: string; durationMs?: number | null; sizeBytes: bigint; width: number | null; height: number | null; deletedAt: Date | null; objectKey: string; note: string | null; contentHash?: string | null; thumbnail?: { id: string; deletedAt: Date | null; contentHash?: string | null; width?: number | null; height?: number | null } | null };
  }, user: AuthUser): Record<string, unknown> {
    return {
      id: row.asset.id,
      shareId: row.id,
      role: row.asset.role,
      mimeType: row.asset.mimeType,
      mediaKind: row.asset.mediaKind ?? 'IMAGE',
      durationMs: row.asset.durationMs ?? null,
      width: row.asset.width,
      height: row.asset.height,
      sizeBytes: row.asset.sizeBytes.toString(),
      visibility: 'shared',
      sharedAt: row.createdAt,
      team: row.team,
      sharedBy: { displayName: row.sharedBy.displayName || row.sharedBy.username },
      canUnshare: row.asset.userId === user.id || user.role === 'ADMIN',
      note: null,
      generationPrompt: null,
      ...serializeAssetLinks({ id: row.asset.id, deletedAt: row.asset.deletedAt, contentHash: row.asset.contentHash, thumbnail: row.asset.thumbnail }),
    };
  }
}

function isMaskUpload(value: unknown) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).role === 'MASK');
}

export function parseByteRange(header: unknown, size: number) {
  if (typeof header !== 'string' || !header.startsWith('bytes=') || !Number.isInteger(size) || size <= 0) return null;
  const spec = header.slice(6).split(',')[0]?.trim();
  if (!spec) return null;
  const [startRaw, endRaw] = spec.split('-');
  let start: number;
  let end: number;
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' || endRaw === undefined ? size - 1 : Number(endRaw);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= size || start > end) return null;
  return { start, end };
}

function parseOptionalTeamId(raw: unknown) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') throw new BadRequestException('工作团队无效');
  return parseTeamId(raw);
}

function parseTeamId(raw: string) {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException('工作团队无效');
  return parsed.data;
}
