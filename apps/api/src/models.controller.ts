import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser, Roles, type AuthUser } from './common';
import { PrismaService } from './prisma.service';
import { parseBody, safeText, uuidSchema } from './validation';
import { z } from 'zod';
import { accessibleModelWhere } from './model-access';
import { Prisma } from './generated/prisma/client';
import { ACTIVE_JOB_STATUSES, mediaKindForAdapter, PROVIDER_ADAPTER_KINDS } from './domain-constants';
import { cleanImageRatios, cleanImageTiers, computeImageSize, DEFAULT_IMAGE_RATIOS, DEFAULT_IMAGE_TIERS, imageSizeAllowed } from './resolution';
import { MAX_POINT_MULTIPLIER } from './generation-quota';
import { applyPrivateCatalogCache, catalogEtag } from './cache-policy';

const defaults = { size: 'auto', quality: 'standard', count: 1 };
const qualities = ['standard'];
const optionValueSchema = z.string().trim().min(1).max(64);
const sizeOptionSchema = z.array(optionValueSchema).max(20);
const optionSchema = z.array(optionValueSchema).max(20);
const durationsSchema = z.array(z.number().int().min(1).max(60)).max(20);
const groupIdsSchema = z.array(uuidSchema).max(100);
const resolutionTierSchema = z.object({
  label: z.string().trim().min(1).max(16),
  shortEdge: z.number().int().min(64).max(8192),
}).strict();
const ratioSchema = z.string().trim().regex(/^\d{1,4}:\d{1,4}$/);
const modelSchema = z.object({
  providerId: uuidSchema, displayName: safeText(128), upstreamModelId: safeText(256),
  adapterKind: z.enum(PROVIDER_ADAPTER_KINDS),
  mediaKind: z.enum(['IMAGE', 'VIDEO']).optional(),
  allowedSizes: sizeOptionSchema.optional(), allowedQualities: optionSchema.optional(), allowedDurations: durationsSchema.optional(),
  resolutionTiers: z.array(resolutionTierSchema).max(12).optional(), allowedRatios: z.array(ratioSchema).max(12).optional(),
  supportsGeneration: z.boolean().optional(), supportsEdit: z.boolean().optional(), supportsInpaint: z.boolean().optional(),
  supportsFirstLastFrame: z.boolean().optional(),
  maxImages: z.number().int().min(1).max(4).optional(), maxInputImages: z.number().int().min(1).max(8).optional(),
  defaults: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional(), sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
	costPerUnit: z.number().int().min(1).max(1000).optional(),
  pointMultipliers: z.record(z.string(), z.number()).nullable().optional(),
  allowedGroupIds: groupIdsSchema.optional(),
}).strict();
type ModelInput = z.infer<typeof modelSchema>;

@Controller()
export class ModelsController {
  constructor(private prisma: PrismaService) {}

  @Get('models')
  async publicModels(@CurrentUser() user: AuthUser, @Req() request?: Request, @Res({ passthrough: true }) response?: Response) {
    const models = await this.prisma.model.findMany({
      where: { enabled: true, provider: { enabled: true, archivedAt: null }, ...accessibleModelWhere(user) },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
      select: { id: true, displayName: true, mediaKind: true, supportsGeneration: true, supportsEdit: true, supportsInpaint: true, supportsFirstLastFrame: true, allowedSizes: true, allowedQualities: true, allowedDurations: true, resolutionTiers: true, allowedRatios: true, maxImages: true, maxInputImages: true, defaults: true, costPerUnit: true, pointMultipliers: true },
    });
    if (applyPrivateCatalogCache(request, response, catalogEtag(user.id, user.groupIds, models))) return;
    return models;
  }

  @Roles('ADMIN') @Get('admin/models')
  adminModels() {
    return this.prisma.model.findMany({ where: { provider: { archivedAt: null } }, orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }], include: { provider: { select: { id: true, name: true } }, allowedGroups: { select: { groupId: true, group: { select: { id: true, name: true } } } } } });
  }

  @Roles('ADMIN') @Post('admin/models')
  async create(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    const body = parseBody(modelSchema, raw);
    await this.assertGroupsExist(body.allowedGroupIds ?? []);
    const model = await this.prisma.model.create({ data: { ...await this.data(body), allowedGroups: { create: (body.allowedGroupIds ?? []).map((groupId) => ({ groupId })) } } });
    await this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'model.created', targetType: 'model', targetId: model.id } });
    return model;
  }

  @Roles('ADMIN') @Patch('admin/models/:id')
  async update(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(modelSchema.partial().strict(), raw);
    const current = await this.prisma.model.findUniqueOrThrow({ where: { id } });
    // 库里的 mediaKind 由适配器推导；显式覆盖，避免只改 adapterKind 时被旧值误判为不匹配
    const merged = { ...current, ...body, mediaKind: body.mediaKind } as ModelInput;
    if (body.allowedGroupIds) await this.assertGroupsExist(body.allowedGroupIds);
    const model = await this.prisma.model.update({ where: { id }, data: {
      ...await this.data(merged),
      ...(body.allowedGroupIds ? { allowedGroups: { deleteMany: {}, create: body.allowedGroupIds.map((groupId) => ({ groupId })) } } : {}),
    } });
    await this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'model.updated', targetType: 'model', targetId: id } });
    return model;
  }

  @Roles('ADMIN') @Delete('admin/models/:id')
  async remove(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.prisma.$transaction(async (tx) => {
      const activeJobs = await tx.generationJob.count({ where: { modelId: id, status: { in: [...ACTIVE_JOB_STATUSES] } } });
      if (activeJobs) throw new ConflictException('该模型仍有正在排队或运行的任务，请等待任务完成后再删除');
      await tx.model.delete({ where: { id } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'model.deleted', targetType: 'model', targetId: id } });
      return { ok: true };
    });
  }

  private async data(body: ModelInput) {
    const provider = await this.prisma.provider.findUnique({ where: { id: body.providerId }, select: { id: true } });
    if (!provider) throw new BadRequestException('供应商不存在');
    const adapterKind = body.adapterKind;
    const mediaKind = mediaKindForAdapter(adapterKind);
    if (body.mediaKind && body.mediaKind !== mediaKind) throw new BadRequestException('模型类型与适配器类型不匹配');
    const video = mediaKind === 'VIDEO';
    const requestedSizes = body.allowedSizes ?? (video ? ['16:9', '9:16', '1:1'] : []);
    const allowedSizes = video ? (requestedSizes.length ? requestedSizes : ['16:9']) : [];
    // 档位（名称 + 短边）对图片与视频模型统一生效；图片缺省回退默认档位
    const resolutionTiers = (() => {
      const cleaned = cleanImageTiers(body.resolutionTiers) ?? [];
      return cleaned.length ? cleaned : (video ? [] : DEFAULT_IMAGE_TIERS);
    })();
    const tierLabels = resolutionTiers.map((tier) => tier.label);
    const requestedQualities = body.allowedQualities ?? (video ? [] : qualities);
    // 视频模型的分辨率即档位名称（如 720P / 1080P），直接派生于档位
    const allowedQualities = video && resolutionTiers.length ? tierLabels : requestedQualities;
    if (!video && !allowedQualities.length) throw new BadRequestException('质量必须为数组');
    const allowedDurations = video ? uniqueDurations(body.allowedDurations) : [];
    const allowedRatios = video ? [] : (() => {
      const cleaned = cleanImageRatios(body.allowedRatios) ?? [];
      return cleaned.length ? cleaned : DEFAULT_IMAGE_RATIOS;
    })();
    const requestedDefaults = (body.defaults && typeof body.defaults === 'object' ? body.defaults : defaults) as Record<string, unknown>;
    const firstSize = resolutionTiers.length && allowedRatios.length ? computeImageSize(resolutionTiers[0].shortEdge, allowedRatios[0]) : allowedSizes[0];
    const defaultSize = typeof requestedDefaults.size === 'string' && (video ? allowedSizes.includes(requestedDefaults.size) : imageSizeAllowed(resolutionTiers, allowedRatios, requestedDefaults.size))
      ? requestedDefaults.size : firstSize;
    const defaultQuality = allowedQualities.length
      ? (typeof requestedDefaults.quality === 'string' && allowedQualities.includes(requestedDefaults.quality) ? requestedDefaults.quality : allowedQualities[0])
      : undefined;
    const maxImages = video ? 1 : (body.maxImages ?? 1);
    const defaultCount = video ? 1 : Math.min(maxImages, typeof requestedDefaults.count === 'number' ? requestedDefaults.count : 1);
    const defaultDuration = video
      ? (typeof requestedDefaults.durationSeconds === 'number' && allowedDurations.includes(requestedDefaults.durationSeconds) ? requestedDefaults.durationSeconds : allowedDurations[0])
      : undefined;
    const supportsFirstLastFrame = video && Boolean(body.supportsFirstLastFrame);
    const pointMultipliers = sanitizePointMultipliers(body.pointMultipliers);
    return {
      providerId: body.providerId, displayName: String(body.displayName).trim(), upstreamModelId: String(body.upstreamModelId).trim(), adapterKind, mediaKind,
      supportsGeneration: body.supportsGeneration !== false, supportsEdit: Boolean(body.supportsEdit), supportsInpaint: adapterKind === 'openai-images' && Boolean(body.supportsInpaint),
      supportsFirstLastFrame,
      allowedSizes, allowedQualities, allowedDurations, resolutionTiers, allowedRatios,
      maxImages, maxInputImages: Math.min(8, Math.max(supportsFirstLastFrame ? 2 : 1, body.maxInputImages ?? 1)),
      defaults: { ...requestedDefaults, size: defaultSize, ...(defaultQuality !== undefined ? { quality: defaultQuality } : { quality: undefined }), count: defaultCount, ...(defaultDuration !== undefined ? { durationSeconds: defaultDuration } : {}) },
      enabled: body.enabled !== false, sortOrder: body.sortOrder ?? 0,
      costPerUnit: body.costPerUnit ?? 1,
      pointMultipliers: pointMultipliers === null ? Prisma.DbNull : pointMultipliers,
    };
  }

  private async assertGroupsExist(groupIds: string[]) {
    const uniqueIds = [...new Set(groupIds)];
    if (uniqueIds.length !== groupIds.length) throw new BadRequestException('用户组不能重复');
    if (!uniqueIds.length) return;
    const count = await this.prisma.userGroup.count({ where: { id: { in: uniqueIds } } });
    if (count !== uniqueIds.length) throw new BadRequestException('包含不存在的用户组');
  }
}

function uniqueDurations(value: unknown) {
  const source = Array.isArray(value) && value.length ? value : [5, 10];
  const durations = [...new Set(source.filter((item) => Number.isInteger(item) && item >= 1 && item <= 60))];
  return durations;
}
function sanitizePointMultipliers(value: unknown): Record<string, number> | null | undefined {
  if (value === undefined) return undefined; // 未提供 → 更新时跳过,保留现值
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null; // 显式清空
  const result: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) continue;
    const number = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(number) || number <= 0 || number > MAX_POINT_MULTIPLIER) continue;
    result[key] = number;
  }
  return Object.keys(result).length ? result : null;
}
