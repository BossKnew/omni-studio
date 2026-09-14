import { GenerationLifecycleService } from './generation-lifecycle.service';

describe('GenerationLifecycleService', () => {
  it('settles an active job and releases quota before publishing its event', async () => {
    const calls: string[] = [];
    const prisma: any = { generationJob: {
      updateMany: jest.fn(async () => { calls.push('update'); return { count: 1 }; }),
      findFirst: jest.fn().mockResolvedValue(null),
    } };
    const quota: any = { releaseJob: jest.fn(async () => { calls.push('release'); }) };
    const events: any = { publish: jest.fn(async () => { calls.push('publish'); }) };
    const service = new GenerationLifecycleService(prisma, quota, events);

    await expect(service.finish('user-1', 'job-1', 'FAILED', { code: 'QUEUE_FAILED', message: '提交失败' })).resolves.toBe(true);

    expect(prisma.generationJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'job-1', userId: 'user-1', status: { in: ['QUEUED', 'RUNNING'] } }),
      data: expect.objectContaining({ status: 'FAILED', errorCode: 'QUEUE_FAILED' }),
    }));
    expect(calls).toEqual(['update', 'release', 'publish']);
  });

  it('does not overwrite a job that already became terminal', async () => {
    const prisma: any = { generationJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), findFirst: jest.fn().mockResolvedValue(null) } };
    const quota: any = { releaseJob: jest.fn().mockResolvedValue(undefined) };
    const events: any = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = new GenerationLifecycleService(prisma, quota, events);

    await expect(service.finish('user-1', 'job-1', 'SUCCEEDED')).resolves.toBe(false);

    expect(quota.releaseJob).toHaveBeenCalledWith('user-1', 'job-1');
    expect(events.publish).toHaveBeenCalledWith('user-1', 'job-1');
    expect(prisma.generationJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'job-1', userId: 'user-1' } }));
  });
});
