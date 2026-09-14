import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { writeFile } from 'node:fs/promises';
import { CryptoService } from './crypto.service';
import { PrismaService } from './prisma.service';
import { StorageService } from './storage.service';
import { safeErrorMessage } from './common';
import { MAX_IMAGE_BYTES, VIDEO_LOCK_DURATION_MS, isVideoGenerationMode } from './domain-constants';
import { SafeHttpService } from './safe-http.service';
import { securityConfig } from './security-config';
import { AssetLifecycleService } from './asset-lifecycle.service';
import { providerRequestHeaders } from './provider-credentials';
import { GenerationLifecycleService } from './generation-lifecycle.service';
import { accessibleSourceWhere } from './asset-access';
import { createVideoAdapter } from './video-adapters';
import { mapProviderRequestError, type GeneratedMedia, type MediaGenerationRequest } from './provider-adapter';
import { sourceAssetIdsFromParameters } from './generation-response';
import type { AuthUser } from './common';

@Processor('video-generation', {
  concurrency: securityConfig.videoWorkerConcurrency(),
  lockDuration: VIDEO_LOCK_DURATION_MS,
  stalledInterval: 60_000,
})
export class VideoGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoGenerationProcessor.name);
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private storage: StorageService,
    private http: SafeHttpService,
    private assets: AssetLifecycleService,
    private lifecycle: GenerationLifecycleService,
  ) { super(); }

  async process(queueJob: Job<{ jobId: string }>) {
    const job = await this.prisma.generationJob.findUnique({
      where: { id: queueJob.data.jobId },
      select: {
        id: true,
        userId: true,
        mode: true,
        prompt: true,
        parameters: true,
        status: true,
        user: { select: { status: true, role: true } },
        model: {
          select: {
            adapterKind: true,
            upstreamModelId: true,
            provider: { select: { baseUrl: true, encryptedApiKey: true, encryptedHeaders: true, timeoutSeconds: true, pollTimeoutSeconds: true } },
          },
        },
      },
    });
    if (!job) return;
    if (job.status === 'CANCELLED' || job.user.status !== 'ACTIVE') { await this.lifecycle.releaseAndPublish(job.userId, job.id); return; }
    if (!job.model || !isVideoGenerationMode(job.mode)) {
      await this.lifecycle.finish(job.userId, job.id, 'FAILED', { code: 'MODEL_DELETED', message: '模型已被删除' });
      return;
    }
    if (!await this.lifecycle.start(job.userId, job.id)) {
      await this.lifecycle.releaseAndPublish(job.userId, job.id);
      return;
    }
    try {
      const params = (job.parameters && typeof job.parameters === 'object' && !Array.isArray(job.parameters) ? job.parameters : {}) as Record<string, unknown>;
      this.logger.log(`视频任务 ${job.id} 开始：生成超时 ${job.model.provider.timeoutSeconds}s，任务等待 ${job.model.provider.pollTimeoutSeconds}s`);
      const adapter = createVideoAdapter(job.model.adapterKind, {
        http: this.http,
        headers: providerRequestHeaders(this.crypto, job.model.provider),
        baseUrl: job.model.provider.baseUrl,
        timeoutSeconds: job.model.provider.timeoutSeconds,
        pollTimeoutSeconds: job.model.provider.pollTimeoutSeconds,
        createStagingPath: (extension) => this.storage.createStagingPath(extension),
      });
      const request = await this.buildRequest(job, params, job.model.upstreamModelId);
      let taskId = typeof params.providerTaskId === 'string' && params.providerTaskId.trim() ? params.providerTaskId.trim() : '';
      if (!taskId) {
        taskId = await adapter.createTask(request);
        await this.prisma.generationJob.update({ where: { id: job.id }, data: { parameters: { ...params, providerTaskId: taskId } } });
      }
      const outputs = await adapter.collect(taskId, request);
      const [freshUser, freshJob] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: job.userId }, select: { status: true } }),
        this.prisma.generationJob.findUnique({ where: { id: job.id }, select: { status: true } }),
      ]);
      if (!freshUser || freshUser.status !== 'ACTIVE' || !freshJob || freshJob.status === 'CANCELLED') {
        await this.lifecycle.finish(job.userId, job.id, 'CANCELLED');
        await Promise.all(outputs.map((output) => output.path ? this.storage.deleteStaged(output.path).catch(() => undefined) : Promise.resolve()));
        return;
      }
      try {
        for (const output of outputs) await this.persistOutput(job.userId, job.id, output);
      } finally {
        await Promise.all(outputs.map((output) => output.path ? this.storage.deleteStaged(output.path).catch(() => undefined) : Promise.resolve()));
      }
      const completed = await this.lifecycle.finish(job.userId, job.id, 'SUCCEEDED');
      if (!completed) await this.assets.removeJobOutputs(job.userId, job.id);
    } catch (caught: any) {
      const error: any = mapProviderRequestError(caught);
      const finalAttempt = error?.noRetry || queueJob.attemptsMade + 1 >= (queueJob.opts.attempts ?? 1);
      const cause = caught?.cause ?? caught;
      this.logger.warn(`视频任务 ${job.id} 失败：${safeErrorMessage(error)} code=${cause?.code ?? caught?.code ?? 'n/a'} cause=${safeErrorMessage(cause)}（生成超时 ${job.model.provider.timeoutSeconds}s，任务等待 ${job.model.provider.pollTimeoutSeconds}s）`);
      if (finalAttempt) {
        const failure = error?.providerFailure ?? (error?.providerConnection ? { code: 'PROVIDER_CONNECTION', message: '无法连接供应商、响应过大或请求超时，请管理员检查网络、超时和响应限制' } : { code: 'GENERATION_FAILED', message: videoFailureMessage(error) });
        await this.lifecycle.finish(job.userId, job.id, 'FAILED', failure);
      }
      if (error?.noRetry) throw new UnrecoverableError(safeErrorMessage(error));
      throw error;
    }
  }

  private async buildRequest(job: { id: string; userId: string; mode: string; prompt: string; user: { role: AuthUser['role'] } }, params: Record<string, unknown>, upstreamModelId: string): Promise<MediaGenerationRequest> {
    const sourceIds = sourceAssetIdsFromParameters(params);
    const reader = job.user.role === 'ADMIN'
      ? { id: job.userId, role: job.user.role, teamIds: [] as string[] }
      : { id: job.userId, role: job.user.role, teamIds: (await this.prisma.workTeamMembership.findMany({ where: { userId: job.userId }, select: { teamId: true } })).map(({ teamId }) => teamId) };
    const inputAssets = [];
    for (const assetId of sourceIds) {
      const asset = await this.prisma.asset.findFirst({
        where: { id: assetId, ...accessibleSourceWhere(reader as AuthUser) },
        select: { objectKey: true, mimeType: true },
      });
      if (!asset) throw Object.assign(new Error('引用图片不存在'), { noRetry: true, providerFailure: { code: 'PROVIDER_PARAMETERS', message: '参考图不存在，无法生成视频' } });
      const bytes = await this.readAssetBytes(asset.objectKey);
      inputAssets.push({ mimeType: asset.mimeType, bytes, role: 'SOURCE' as const });
    }
    return {
      mediaKind: 'VIDEO',
      operation: job.mode === 'TEXT_TO_VIDEO' ? 'TEXT_TO_VIDEO' : 'IMAGE_TO_VIDEO',
      upstreamModelId,
      prompt: job.prompt,
      parameters: params,
      inputAssets,
    };
  }

  private async readAssetBytes(objectKey: string) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of this.storage.createReadStream(objectKey)) {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) throw Object.assign(new Error('参考图超过大小限制'), { noRetry: true });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  private async persistOutput(userId: string, jobId: string, output: GeneratedMedia) {
    let staged = output.path;
    if (!staged) {
      staged = await this.storage.createStagingPath('.mp4');
      await writeFile(staged, output.bytes ?? Buffer.alloc(0), { flag: 'wx' });
    }
    let inspected;
    try { inspected = await this.storage.inspectVideoFile(staged); }
    catch (error) {
      if (staged !== output.path) await this.storage.deleteStaged(staged).catch(() => undefined);
      throw error;
    }
    await this.assets.persistVideo({ userId, jobId, video: inspected });
  }
}

function videoFailureMessage(error: unknown) {
  const message = safeErrorMessage(error);
  if (!message || message === 'unknown') return '视频生成失败';
  if (/ffprobe|ffmpeg|无法解析视频/i.test(message)) return '视频已从供应商返回，但本机无法解析视频文件。请安装 ffmpeg 后重试，或使用 Docker 部署';
  if (/MP4|空的视频/i.test(message)) return message;
  if (/远端目标|必须使用 HTTPS/i.test(message)) return '无法下载生成结果：供应商视频地址被安全策略拦截，请检查出站网络';
  if (/aborted due to timeout|TimeoutError|请求超时/i.test(message)) return '供应商请求超时，请稍后重试或让管理员提高生成超时和任务等待超时';
  return `视频生成失败：${message}`;
}
