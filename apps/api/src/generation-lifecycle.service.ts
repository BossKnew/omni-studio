import { Injectable } from '@nestjs/common';
import { ACTIVE_JOB_STATUSES, type TerminalJobStatus } from './domain-constants';
import { GenerationEventsService } from './generation-events.service';
import { generationJobSelect, serializeGenerationJob } from './generation-response';
import { PrismaService } from './prisma.service';
import { QuotaService } from './quota.service';

@Injectable()
export class GenerationLifecycleService {
  constructor(
    private prisma: PrismaService,
    private quota: QuotaService,
    private events: GenerationEventsService,
  ) {}

  async start(userId: string, jobId: string) {
    const result = await this.prisma.generationJob.updateMany({
      where: { id: jobId, userId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      data: { status: 'RUNNING', startedAt: new Date(), errorCode: null, errorMessage: null },
    });
    if (result.count) await this.publish(userId, jobId);
    return Boolean(result.count);
  }

  async finish(userId: string, jobId: string, status: TerminalJobStatus, failure?: { code: string; message: string }) {
    const result = await this.prisma.generationJob.updateMany({
      where: { id: jobId, userId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      data: {
        status,
        finishedAt: new Date(),
        errorCode: status === 'FAILED' ? failure?.code ?? 'GENERATION_FAILED' : null,
        errorMessage: status === 'FAILED' ? failure?.message ?? '图片生成失败' : null,
      },
    });
    await this.releaseAndPublish(userId, jobId);
    return Boolean(result.count);
  }

  async releaseAndPublish(userId: string, jobId: string) {
    await this.quota.releaseJob(userId, jobId);
    await this.publish(userId, jobId);
  }

  async publish(userId: string, jobId: string) {
    const job = await this.prisma.generationJob.findFirst({ where: { id: jobId, userId }, select: generationJobSelect }).catch(() => null);
    await this.events.publish(userId, job ? serializeGenerationJob(job) : jobId).catch(() => undefined);
  }
}
