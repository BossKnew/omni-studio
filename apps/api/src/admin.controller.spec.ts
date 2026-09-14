import { BadRequestException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { UPLOAD_IMAGE_SETTING_KEY } from './upload-image-policy';

describe('AdminController user statistics', () => {
  it('returns storage usage without counting jobs or assets per user', async () => {
    const prisma: any = {
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'user-1', username: 'alice', displayName: null, role: 'USER', status: 'ACTIVE', mustChangePwd: false, createdAt: new Date(), updatedAt: new Date(), usage: { storageBytes: 4096n }, mfaCredential: null, groupMemberships: [], teamMemberships: [] }]) },
    };
    const controller = new AdminController(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const result = await controller.users();

    expect(result.items[0]).toMatchObject({ storageBytes: '4096' });
    expect(result.items[0]).not.toHaveProperty('_count');
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.not.objectContaining({ _count: expect.anything() }),
    }));
  });

  it('uses the shared cancellation flow when disabling a user', async () => {
    const queued = { remove: jest.fn().mockResolvedValue(undefined) };
    const unrelated = { remove: jest.fn().mockResolvedValue(undefined) };
    const lifecycle = { releaseAndPublish: jest.fn().mockResolvedValue(undefined) };
    const prisma: any = {
      user: { update: jest.fn().mockResolvedValue({ id: 'user-1', username: 'alice', role: 'USER', status: 'DISABLED' }) },
      generationJob: { findMany: jest.fn().mockResolvedValue([{ id: 'queued-1', status: 'QUEUED' }, { id: 'running-1', status: 'RUNNING' }]), updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const auth = { revokeUser: jest.fn().mockResolvedValue(undefined) };
    const queue = {
      getJobs: jest.fn().mockResolvedValue([
        { id: 'retry-queued-1-123', data: { jobId: 'queued-1' }, ...queued },
        { id: 'another-job', data: { jobId: 'another-database-job' }, ...unrelated },
      ]),
    };
    const videoQueue = { getJobs: jest.fn().mockResolvedValue([]) };
    const controller = new AdminController(prisma, auth as any, {} as any, queue as any, videoQueue as any, { invalidate: jest.fn().mockResolvedValue(undefined) } as any, lifecycle as any);

    await controller.userStatus({ id: 'admin-1' } as any, 'user-1', { status: 'DISABLED' });

    expect(queue.getJobs).toHaveBeenCalledWith(['waiting', 'delayed', 'prioritized'], 0, -1, true);
    expect(queued.remove).toHaveBeenCalledTimes(1);
    expect(unrelated.remove).not.toHaveBeenCalled();
    expect(prisma.generationJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }));
    expect(lifecycle.releaseAndPublish).toHaveBeenCalledTimes(2);
  });

  it('returns the upload max long edge with other system settings', async () => {
    const prisma: any = {
      systemSetting: {
        findUnique: jest.fn(async ({ where: { key } }: { where: { key: string } }) => {
          if (key === 'trash_retention') return { value: '7d' };
          if (key === UPLOAD_IMAGE_SETTING_KEY) return { value: { maxLongEdge: 2048 } };
          return null;
        }),
      },
    };
    const auth = { registrationEnabled: jest.fn().mockResolvedValue(true), userSessionDuration: jest.fn().mockResolvedValue('7d') };
    const controller = new AdminController(prisma, auth as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    await expect(controller.settings()).resolves.toMatchObject({
      registrationEnabled: true,
      userSessionDuration: '7d',
      trashRetention: '7d',
      uploadMaxLongEdge: 2048,
    });
  });

  it('saves a valid upload max long edge and rejects values outside the allowed step', async () => {
    const prisma: any = {
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
      systemSetting: { upsert: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const controller = new AdminController(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    await expect(controller.uploadImage({ id: 'admin-1' } as any, { maxLongEdge: 2048 })).resolves.toEqual({ maxLongEdge: 2048 });
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: UPLOAD_IMAGE_SETTING_KEY },
      create: { key: UPLOAD_IMAGE_SETTING_KEY, value: { maxLongEdge: 2048 } },
    }));
    await expect(controller.uploadImage({ id: 'admin-1' } as any, { maxLongEdge: 1000 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
