import { BadRequestException, Body, ConflictException, Controller, Get, MessageEvent, NotFoundException, Param, ParseUUIDPipe, Post, Query, Sse } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Observable } from 'rxjs';
import { CurrentUser, type AuthUser } from './common';
import { PrismaService } from './prisma.service';
import { RateLimitService } from './rate-limit.service';
import { QuotaService } from './quota.service';
import { securityConfig } from './security-config';
import { parseBody, uuidSchema } from './validation';
import { z } from 'zod';
import { accessibleModelWhere, canAccessModel } from './model-access';
import { generationJobSelect, readGenerationParameters, serializeGenerationJob } from './generation-response';
import { AssetLifecycleService } from './asset-lifecycle.service';
import { GENERATION_QUEUE_OPTIONS, isVideoGenerationMode } from './domain-constants';
import { GenerationEventsService } from './generation-events.service';
import { GenerationLifecycleService } from './generation-lifecycle.service';
import { serializeAssetLinks } from './asset-response';
import { computeImageSize, imageSizeAllowed, tierLabelForSize, type ResolutionTier } from './resolution';
import { accessibleReferencedAssetWhere, accessibleSourceWhere } from './asset-access';
import { pointsForGeneration } from './generation-quota';
import { MAX_PROVIDER_PROMPT, isStylePresetId, providerPromptFor, stylePresetAllowedForMode } from './style-presets';
import { promptHash } from './prompt-hash';

const generationSchema = z.object({
  prompt: z.string().max(8000).optional(), modelId: uuidSchema, mode: z.enum(['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'INPAINT', 'TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO', 'FIRST_LAST_FRAME_TO_VIDEO']).optional(),
  size: z.string().max(64).optional(), quality: z.string().max(64).optional(), count: z.number().int().min(1).max(4).optional(),
  durationSeconds: z.number().int().min(1).max(60).optional(),
  sourceAssetIds: z.array(uuidSchema).max(8).optional(), maskAssetId: uuidSchema.nullish(), conversationId: uuidSchema.nullish(),
  stylePresetId: z.string().max(64).optional(),
}).strict();

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

export function conversationTitleFromPrompt(prompt: string, styleNameZh?: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return styleNameZh ? `${styleNameZh}转绘` : '新创作';
  if (CJK.test(trimmed)) return Array.from(trimmed).slice(0, 10).join('');
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length) return words.slice(0, 4).join(' ');
  return Array.from(trimmed).slice(0, 10).join('');
}

@Controller('generations')
export class GenerationsController {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('image-generation') private queue: Queue,
    @InjectQueue('video-generation') private videoQueue: Queue,
    private limits: RateLimitService,
    private quota: QuotaService,
    private assets: AssetLifecycleService,
    private lifecycle: GenerationLifecycleService,
    private generationEvents: GenerationEventsService,
  ) {}

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() raw: unknown) {
    const body = parseBody(generationSchema, raw);
    await this.limits.consume('generation-user', user.id, securityConfig.generationLimit(), 600);
    const prompt = body.prompt?.trim() ?? '';
    const requestedStylePresetId = body.stylePresetId?.trim() ?? '';
    if (requestedStylePresetId && !isStylePresetId(requestedStylePresetId)) throw new BadRequestException('风格预设无效');
    const stylePreset = requestedStylePresetId ? await this.prisma.stylePreset.findUnique({ where: { id: requestedStylePresetId } }) : null;
    if (requestedStylePresetId && !stylePreset) throw new BadRequestException('风格预设无效');
    const stylePresetId = stylePreset?.id;
    const model = await this.prisma.model.findFirst({ where: { id: body.modelId, enabled: true, provider: { enabled: true, archivedAt: null }, ...accessibleModelWhere(user) }, include: { provider: { select: { name: true } } } });
    if (!model) throw new BadRequestException('模型不可用');
    const videoModel = model.mediaKind === 'VIDEO';
    const mode = body.mode ?? (videoModel ? 'TEXT_TO_VIDEO' : 'TEXT_TO_IMAGE');
    if (videoModel !== isVideoGenerationMode(mode)) throw new BadRequestException('生成模式与模型类型不匹配');
    if (stylePresetId && !stylePresetAllowedForMode(mode)) throw new BadRequestException('当前模式不支持风格预设');
    if (!prompt && !(mode === 'IMAGE_EDIT' && stylePresetId)) throw new BadRequestException('提示词长度必须为 1-8000 字符');
    if (providerPromptFor(mode, prompt, stylePreset).length > MAX_PROVIDER_PROMPT) throw new BadRequestException('加上风格后提示词超过 8000 字符，请缩短原文');
    if (mode === 'TEXT_TO_IMAGE' && !model.supportsGeneration) throw new BadRequestException('模型不支持文生图');
    if (mode === 'IMAGE_EDIT' && !model.supportsEdit) throw new BadRequestException('模型不支持图片编辑');
    if (mode === 'INPAINT' && !model.supportsInpaint) throw new BadRequestException('模型不支持局部重绘');
    if (mode === 'TEXT_TO_VIDEO' && !model.supportsGeneration) throw new BadRequestException('模型不支持文生视频');
    if (mode === 'IMAGE_TO_VIDEO' && !model.supportsEdit) throw new BadRequestException('模型不支持图生视频');
    if (mode === 'FIRST_LAST_FRAME_TO_VIDEO' && !model.supportsFirstLastFrame) throw new BadRequestException('模型不支持首尾帧');
    const imageTiers = (model.resolutionTiers as ResolutionTier[]) ?? [];
    const allowedRatios = (model.allowedRatios as string[]) ?? [];
    const allowedSizes = (model.allowedSizes as string[]) ?? [];
    const allowedQualities = (model.allowedQualities as string[]) ?? [];
    const allowedDurations = Array.isArray(model.allowedDurations) ? (model.allowedDurations as number[]) : [];
    const defaults = readGenerationParameters(model.defaults);
    const size = body.size ?? defaults.size ?? (videoModel ? allowedSizes[0] : computeImageSize(imageTiers[0]?.shortEdge ?? 0, allowedRatios[0] ?? '') ?? '1024x1024');
    const quality = body.quality ?? defaults.quality ?? allowedQualities[0];
    const count = videoModel ? 1 : Math.min(model.maxImages, body.count ?? 1);
    const durationSeconds = videoModel ? (body.durationSeconds ?? defaults.durationSeconds ?? allowedDurations[0]) : undefined;
    if (videoModel ? !allowedSizes.includes(size) : !imageSizeAllowed(imageTiers, allowedRatios, size)) throw new BadRequestException(videoModel ? '比例不受该模型支持' : '尺寸或质量不受该模型支持');
    if (allowedQualities.length ? !allowedQualities.includes(quality) : Boolean(body.quality)) throw new BadRequestException(videoModel ? '分辨率不受该模型支持' : '尺寸或质量不受该模型支持');
    if (videoModel && (typeof durationSeconds !== 'number' || !allowedDurations.includes(durationSeconds))) throw new BadRequestException('时长不受该模型支持');
    const sourceIds = body.sourceAssetIds
      ? (mode === 'FIRST_LAST_FRAME_TO_VIDEO' ? body.sourceAssetIds : [...new Set(body.sourceAssetIds)])
      : [];
    if (mode !== 'FIRST_LAST_FRAME_TO_VIDEO' && sourceIds.length > model.maxInputImages) throw new BadRequestException(`该模型最多支持 ${model.maxInputImages} 张参考图`);
    if ((mode === 'TEXT_TO_IMAGE' || mode === 'TEXT_TO_VIDEO') && sourceIds.length) throw new BadRequestException(mode === 'TEXT_TO_VIDEO' ? '文生视频不支持参考图' : '文生图不支持参考图');
    const assetIds = [...sourceIds, ...(body.maskAssetId ? [body.maskAssetId] : [])];
    const assets = assetIds.length ? await this.prisma.asset.findMany({ where: { id: { in: assetIds }, ...accessibleReferencedAssetWhere(user) } }) : [];
    if (assets.length !== new Set(assetIds).size) throw new BadRequestException('引用图片不存在');
    if (assets.some((asset) => asset.mediaKind === 'VIDEO')) throw new BadRequestException('视频不能作为参考图');
    if (mode === 'FIRST_LAST_FRAME_TO_VIDEO' && sourceIds.length !== 2) throw new BadRequestException('首尾帧必须提供首帧和尾帧');
    if (mode === 'IMAGE_TO_VIDEO' && !sourceIds.length) throw new BadRequestException('图生视频必须提供参考图');
    if (mode !== 'TEXT_TO_IMAGE' && mode !== 'TEXT_TO_VIDEO' && mode !== 'IMAGE_TO_VIDEO' && mode !== 'FIRST_LAST_FRAME_TO_VIDEO' && !sourceIds.length) throw new BadRequestException('编辑模式必须提供原图');
    if (mode === 'INPAINT' && !body.maskAssetId) throw new BadRequestException('局部重绘必须提供遮罩');
    if (videoModel && body.maskAssetId) throw new BadRequestException('视频生成不支持遮罩');
    let conversationId = body.conversationId;
    if (conversationId) {
      if (!await this.prisma.conversation.findFirst({ where: { id: conversationId, userId: user.id } })) throw new NotFoundException('会话不存在');
    }
    const parameters = { size, quality, count, ...(durationSeconds !== undefined ? { durationSeconds } : {}), sourceAssetIds: sourceIds, maskAssetId: body.maskAssetId ?? null, ...(stylePreset ? { stylePresetId: stylePreset.id, styleSuffix: stylePreset.suffix } : {}) };
    const result = await this.prisma.$transaction(async (transaction) => {
      const targetConversationId = conversationId ?? (await transaction.conversation.create({ data: { userId: user.id, title: conversationTitleFromPrompt(prompt, stylePreset?.nameZh) } })).id;
      const promptUsedAt = new Date();
      if (prompt) {
        const hash = promptHash(prompt);
        await transaction.promptEntry.upsert({
          where: { userId_promptHash: { userId: user.id, promptHash: hash } },
          create: { userId: user.id, prompt, promptHash: hash, usageCount: 1, lastUsedAt: promptUsedAt },
          update: { usageCount: { increment: 1 }, lastUsedAt: promptUsedAt },
        });
      }
      const created = await transaction.generationJob.create({ data: {
        userId: user.id, conversationId: targetConversationId, modelId: model.id, mediaKind: videoModel ? 'VIDEO' : 'IMAGE', mode, prompt, parameters, imageCount: count,
        modelSnapshot: { displayName: model.displayName, upstreamModelId: model.upstreamModelId, providerName: model.provider.name },
      }});
      const points = pointsForGeneration({ mediaKind: videoModel ? 'VIDEO' : 'IMAGE', costPerUnit: model.costPerUnit, count, durationSeconds, size, quality, multiplierKey: videoModel ? undefined : tierLabelForSize(imageTiers, size), pointMultipliers: model.pointMultipliers });
      await this.quota.reserveJobInTransaction(transaction, user, points, { jobId: created.id, modelId: model.id, kind: 'SUBMIT', imageCount: videoModel ? 0 : count, videoSeconds: videoModel ? durationSeconds : 0 });
      if (body.maskAssetId) await transaction.asset.updateMany({ where: { id: body.maskAssetId, userId: user.id }, data: { jobId: created.id, role: 'MASK' } });
      return { created, targetConversationId };
    });
    const job = result.created;
    conversationId = result.targetConversationId;
    try {
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      await (videoModel ? this.videoQueue : this.queue).add('generate', { jobId: job.id }, { jobId: job.id, ...GENERATION_QUEUE_OPTIONS });
      await this.lifecycle.publish(user.id, job.id);
    }
    catch (error) {
      await this.lifecycle.finish(user.id, job.id, 'FAILED', { code: 'QUEUE_FAILED', message: '任务提交失败' });
      throw error;
    }
    return { id: job.id, conversationId, status: job.status };
  }

  @Get(':id/reuse')
  async reuse(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const job = await this.prisma.generationJob.findFirst({
      where: { id, userId: user.id },
      select: { modelId: true, mode: true, prompt: true, parameters: true, modelSnapshot: true },
    });
    if (!job) throw new NotFoundException();
    const parameters = readGenerationParameters(job.parameters);
    const sourceAssetIds = [...new Set(parameters.sourceAssetIds ?? [])];
    const sourceRows = sourceAssetIds.length ? await this.prisma.asset.findMany({
      where: { id: { in: sourceAssetIds }, ...accessibleSourceWhere(user) },
      select: {
        id: true, userId: true, role: true, width: true, height: true, mimeType: true, sizeBytes: true, note: true, deletedAt: true, contentHash: true,
        thumbnail: { select: { id: true, deletedAt: true, contentHash: true, width: true, height: true } },
        job: { select: { prompt: true } },
      },
    }) : [];
    if (sourceRows.length !== sourceAssetIds.length) throw new BadRequestException('历史参考图已不存在，无法恢复');
    const sourceById = new Map(sourceRows.map((asset) => [asset.id, asset]));
    const snapshot = job.modelSnapshot && typeof job.modelSnapshot === 'object' && !Array.isArray(job.modelSnapshot) ? job.modelSnapshot as Record<string, unknown> : {};
    const modelDisplayName = typeof snapshot.displayName === 'string' && snapshot.displayName.trim() ? snapshot.displayName : 'Unknown model';
    return {
      prompt: job.prompt,
      mode: job.mode,
      modelId: job.modelId,
      modelDisplayName,
      size: parameters.size ?? null,
      quality: parameters.quality ?? null,
      count: Math.max(1, Number(parameters.count) || 1),
      durationSeconds: parameters.durationSeconds ?? null,
      sourceAssets: sourceAssetIds.map((assetId) => {
        const asset = sourceById.get(assetId)!;
        const owned = asset.userId === user.id;
        return {
          id: asset.id,
          role: asset.role,
          width: asset.width,
          height: asset.height,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes.toString(),
          visibility: owned ? 'owned' : 'shared',
          note: owned ? asset.note ?? null : null,
          generationPrompt: owned ? asset.job?.prompt ?? null : null,
          ...serializeAssetLinks(asset),
        };
      }),
      requiresMaskRedraw: job.mode === 'INPAINT',
      stylePresetId: parameters.stylePresetId ?? null,
    };
  }

  @Post(':id/retry')
  async retry(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const job = await this.prisma.generationJob.findFirst({
      where: { id, userId: user.id },
      include: { model: { include: { provider: true, allowedGroups: { select: { groupId: true } } } }, assets: { where: { role: 'OUTPUT' } } },
    });
    if (!job) throw new NotFoundException();
    if (job.status !== 'FAILED') throw new ConflictException('只有失败的任务可以重试');
    if (!job.model || !job.model.enabled || !job.model.provider.enabled || job.model.provider.archivedAt || !canAccessModel(user, job.model.allowedGroups)) throw new BadRequestException('原任务使用的模型或供应商已不可用');
    const parameters = readGenerationParameters(job.parameters);
    const sourceAssetIds = parameters.sourceAssetIds ?? [];
    const requiredAssetIds = [...sourceAssetIds, ...(parameters.maskAssetId ? [parameters.maskAssetId] : [])];
    const retryAssets = requiredAssetIds.length ? await this.prisma.asset.findMany({ where: { id: { in: requiredAssetIds }, ...accessibleReferencedAssetWhere(user) } }) : [];
    if (retryAssets.length !== new Set(requiredAssetIds).size) throw new BadRequestException(job.mode === 'INPAINT' ? '原任务的参考图或遮罩已不存在，无法重试' : '原任务的参考图已不存在，无法重试');

    const retryVideo = isVideoGenerationMode(job.mode);
    const retryTiers = (job.model.resolutionTiers as ResolutionTier[]) ?? [];
    const points = pointsForGeneration({ mediaKind: retryVideo ? 'VIDEO' : 'IMAGE', costPerUnit: job.model.costPerUnit, count: job.imageCount || Math.max(1, Number(parameters.count) || 1), durationSeconds: parameters.durationSeconds, size: parameters.size, quality: parameters.quality, multiplierKey: retryVideo ? undefined : (parameters.size ? tierLabelForSize(retryTiers, parameters.size) : undefined), pointMultipliers: job.model.pointMultipliers });
    await this.quota.reacquireJob(user, job.id, points, { jobId: job.id, modelId: job.modelId, kind: 'RETRY', imageCount: retryVideo ? 0 : (job.imageCount || Math.max(1, Number(parameters.count) || 1)), videoSeconds: retryVideo ? (parameters.durationSeconds ?? 0) : 0 });
    try {
      await this.assets.removeJobOutputs(user.id, job.id);
    } catch (error) {
      await this.lifecycle.finish(user.id, job.id, 'FAILED', { code: 'RETRY_PREPARE_FAILED', message: '重试准备失败' });
      throw error;
    }

    try {
      await (retryVideo ? this.videoQueue : this.queue).add('generate', { jobId: job.id }, { jobId: `retry-${job.id}-${Date.now()}`, ...GENERATION_QUEUE_OPTIONS });
      await this.lifecycle.publish(user.id, job.id);
    } catch (error) {
      await this.lifecycle.finish(user.id, job.id, 'FAILED', { code: 'RETRY_QUEUE_FAILED', message: '重试任务提交失败' });
      throw error;
    }
    await this.prisma.conversation.update({ where: { id: job.conversationId }, data: { updatedAt: new Date() } });
    return { id: job.id, conversationId: job.conversationId, status: 'QUEUED' };
  }

  @Get('status')
  async statuses(@CurrentUser() user: AuthUser, @Query('ids') rawIds?: string) {
    const ids = [...new Set((rawIds ?? '').split(',').filter(Boolean))];
    if (!ids.length || ids.length > 3 || ids.some((id) => !uuidSchema.safeParse(id).success)) throw new BadRequestException('ids 必须包含 1-3 个任务 ID');
    const jobs = await this.prisma.generationJob.findMany({ where: { id: { in: ids }, userId: user.id }, select: generationJobSelect });
    const byId = new Map(jobs.map((job) => [job.id, job]));
    return ids.flatMap((id) => { const job = byId.get(id); return job ? [serializeGenerationJob(job)] : []; });
  }

  @Sse('events')
  events(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let releaseQuota: (() => Promise<void>) | undefined;
      let unsubscribe: (() => Promise<void>) | undefined;
      let closed = false;
      const heartbeat = setInterval(() => { if (!subscriber.closed) subscriber.next({ type: 'heartbeat', data: '' }); }, 15_000);
      heartbeat.unref?.();

      void (async () => {
        releaseQuota = await this.quota.acquireSse(user.id);
        if (closed) { await releaseQuota(); return; }
        unsubscribe = await this.generationEvents.subscribe(user.id, (job) => { if (!subscriber.closed) subscriber.next({ data: job }); });
        if (closed) await unsubscribe();
      })().catch((error: unknown) => { if (!subscriber.closed) subscriber.error(error); });

      return () => {
        closed = true;
        clearInterval(heartbeat);
        void unsubscribe?.().catch(() => undefined);
        void releaseQuota?.().catch(() => undefined);
      };
    });
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const job = await this.prisma.generationJob.findFirst({ where: { id, userId: user.id }, select: generationJobSelect });
    if (!job) throw new NotFoundException();
    return serializeGenerationJob(job);
  }

}
