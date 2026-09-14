import { BadRequestException } from '@nestjs/common';
import { conversationTitleFromPrompt, GenerationsController } from './generations.controller';
import { STYLE_PRESETS } from './style-presets';

describe('GenerationsController retry', () => {
  const user = { id: 'user-1', role: 'USER', groupIds: ['editors'] } as any;
  let prisma: any;
  let queue: any;
  let assets: any;
  let lifecycle: any;
  let events: any;
  let limits: any;
  let quota: any;
  let controller: GenerationsController;

  beforeEach(() => {
    prisma = {
      generationJob: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
      asset: { findMany: jest.fn(), deleteMany: jest.fn() },
      conversation: { update: jest.fn() },
    };
    queue = { add: jest.fn().mockResolvedValue({}) };
    assets = { removeJobOutputs: jest.fn().mockResolvedValue(0n) };
    lifecycle = { publish: jest.fn().mockResolvedValue(undefined), finish: jest.fn().mockResolvedValue(true) };
    events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    limits = { consume: jest.fn().mockResolvedValue(undefined) };
    quota = {
      releaseJob: jest.fn().mockResolvedValue(undefined),
      reacquireJob: jest.fn().mockResolvedValue(undefined), releaseStorage: jest.fn().mockResolvedValue(undefined), acquireSse: jest.fn().mockResolvedValue(jest.fn().mockResolvedValue(undefined)),
    };
    controller = new GenerationsController(prisma, queue, queue, limits, quota, assets, lifecycle, events);
  });

  it('requeues a failed job with its original source and mask', async () => {
    prisma.generationJob.findFirst.mockResolvedValue({
      id: 'job-1', userId: 'user-1', conversationId: 'conversation-1', status: 'FAILED', mode: 'INPAINT',
      parameters: { sourceAssetIds: ['source-1'], maskAssetId: 'mask-1', size: '1024x1024', quality: 'standard', count: 1 },
      model: { enabled: true, provider: { enabled: true, archivedAt: null }, allowedGroups: [{ groupId: 'editors' }] },
      assets: [{ id: 'partial-output', objectKey: 'user-1/partial.png' }],
    });
    prisma.asset.findMany.mockResolvedValue([{ id: 'source-1' }, { id: 'mask-1' }]);
    prisma.asset.deleteMany.mockResolvedValue({ count: 1 });
    prisma.generationJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.conversation.update.mockResolvedValue({});

    const result = await controller.retry(user, 'job-1');

    expect(result).toEqual({ id: 'job-1', conversationId: 'conversation-1', status: 'QUEUED' });
    expect(assets.removeJobOutputs).toHaveBeenCalledWith('user-1', 'job-1');
    expect(queue.add).toHaveBeenCalledWith('generate', { jobId: 'job-1' }, expect.objectContaining({ attempts: 3 }));
  });

  it('refuses retry when the retained mask no longer exists', async () => {
    prisma.generationJob.findFirst.mockResolvedValue({
      id: 'job-1', userId: 'user-1', conversationId: 'conversation-1', status: 'FAILED', mode: 'INPAINT',
      parameters: { sourceAssetIds: ['source-1'], maskAssetId: 'mask-1' },
      model: { enabled: true, provider: { enabled: true, archivedAt: null }, allowedGroups: [{ groupId: 'editors' }] }, assets: [],
    });
    prisma.asset.findMany.mockResolvedValue([{ id: 'source-1' }]);

    await expect(controller.retry(user, 'job-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses retry after the user loses access to the model group', async () => {
    prisma.generationJob.findFirst.mockResolvedValue({
      id: 'job-1', userId: 'user-1', conversationId: 'conversation-1', status: 'FAILED', mode: 'TEXT_TO_IMAGE', parameters: {},
      model: { enabled: true, provider: { enabled: true, archivedAt: null }, allowedGroups: [{ groupId: 'premium' }] }, assets: [],
    });

    await expect(controller.retry({ id: 'user-1', role: 'USER', groupIds: ['free'] } as any, 'job-1')).rejects.toThrow('模型或供应商已不可用');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns safe reusable parameters and preserves reference order', async () => {
    prisma.generationJob.findFirst.mockResolvedValue({
      modelId: 'model-1', mode: 'IMAGE_EDIT', prompt: 'combine these images',
      parameters: { sourceAssetIds: ['source-2', 'source-1', 'source-2'], size: '1536x1024', quality: 'high', count: 2, maskAssetId: 'mask-1' },
      modelSnapshot: { displayName: 'Editor', upstreamModelId: 'secret-model', providerName: 'secret-provider' },
    });
    prisma.asset.findMany.mockResolvedValue([
      { id: 'source-1', userId: 'user-1', role: 'UPLOAD', width: 10, height: 20, mimeType: 'image/png', sizeBytes: 2n, note: null, deletedAt: null, thumbnail: null, job: null },
      { id: 'source-2', userId: 'user-1', role: 'OUTPUT', width: 30, height: 40, mimeType: 'image/jpeg', sizeBytes: 3n, note: 'ref', deletedAt: null, thumbnail: { id: 'thumb-2', deletedAt: null }, job: { prompt: 'source prompt' } },
    ]);

    const result = await controller.reuse(user, 'job-1');

    expect(result).toMatchObject({ prompt: 'combine these images', modelId: 'model-1', modelDisplayName: 'Editor', mode: 'IMAGE_EDIT', size: '1536x1024', quality: 'high', count: 2, requiresMaskRedraw: false, stylePresetId: null });
    expect(result.sourceAssets.map(({ id }) => id)).toEqual(['source-2', 'source-1']);
    expect(result.sourceAssets[0]).toMatchObject({ visibility: 'owned', note: 'ref', generationPrompt: 'source prompt' });
    expect(JSON.stringify(result)).not.toMatch(/secret-model|secret-provider/);
  });

  it('strips another user\'s prompt when reusing a shared reference', async () => {
    prisma.generationJob.findFirst.mockResolvedValue({
      modelId: 'model-1', mode: 'IMAGE_EDIT', prompt: 'edit with team ref',
      parameters: { sourceAssetIds: ['shared-1'], size: '1024x1024', quality: 'high', count: 1 },
      modelSnapshot: { displayName: 'Editor' },
    });
    prisma.asset.findMany.mockResolvedValue([
      { id: 'shared-1', userId: 'owner-1', role: 'OUTPUT', width: 10, height: 10, mimeType: 'image/png', sizeBytes: 2n, note: 'private', deletedAt: null, thumbnail: null, job: { prompt: 'owner secret prompt' } },
    ]);

    const result = await controller.reuse(user, 'job-1');
    expect(result.sourceAssets[0]).toMatchObject({ id: 'shared-1', visibility: 'shared', note: null, generationPrompt: null });
    expect(JSON.stringify(result)).not.toMatch(/owner secret prompt|private/);
  });

  it('upserts a deduplicated prompt when creating a multi-reference edit', async () => {
    const modelId = '11111111-1111-4111-8111-111111111111';
    const sourceId = '22222222-2222-4222-8222-222222222222';
    const transaction: any = {
      conversation: { create: jest.fn().mockResolvedValue({ id: 'conversation-1' }) },
      promptEntry: { upsert: jest.fn().mockResolvedValue({}) },
      generationJob: { create: jest.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }) },
      asset: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const createPrisma: any = {
      model: { findFirst: jest.fn().mockResolvedValue({ id: modelId, enabled: true, mediaKind: 'IMAGE', supportsGeneration: true, supportsEdit: true, supportsInpaint: false, resolutionTiers: [{ label: '1K', shortEdge: 1024 }], allowedRatios: ['1:1'], allowedQualities: ['standard'], maxImages: 2, maxInputImages: 2, defaults: { size: '1024x1024', quality: 'standard', count: 1 }, costPerUnit: 1, provider: { name: 'provider' } }) },
      asset: { findMany: jest.fn().mockResolvedValue([{ id: sourceId }]) },
      conversation: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((callback: any) => callback(transaction)),
    };
    const createQuota: any = { reserveJobInTransaction: jest.fn().mockResolvedValue(undefined) };
    const createController = new GenerationsController(createPrisma, queue, queue, limits, createQuota, assets, lifecycle, events);

    await createController.create(user, { modelId, prompt: '  combine these images  ', mode: 'IMAGE_EDIT', sourceAssetIds: [sourceId, sourceId] });

    expect(transaction.promptEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_promptHash: { userId: 'user-1', promptHash: expect.stringMatching(/^[0-9a-f]{64}$/) } },
      create: expect.objectContaining({ prompt: 'combine these images', promptHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    }));
    expect(transaction.generationJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ imageCount: 1, parameters: expect.objectContaining({ sourceAssetIds: [sourceId] }) }) }));
    expect(createQuota.reserveJobInTransaction).toHaveBeenCalledWith(transaction, user, 1, expect.objectContaining({ jobId: 'job-1', kind: 'SUBMIT', imageCount: 1, videoSeconds: 0 }));
    expect(transaction.conversation.create).toHaveBeenCalledWith({ data: { userId: 'user-1', title: 'combine these images' } });
  });

  it('charges the resolution multiplier when creating an image', async () => {
    const modelId = '11111111-1111-4111-8111-111111111111';
    const transaction: any = {
      conversation: { create: jest.fn().mockResolvedValue({ id: 'conversation-1' }) },
      promptEntry: { upsert: jest.fn().mockResolvedValue({}) },
      generationJob: { create: jest.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }) },
      asset: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const createPrisma: any = {
      model: { findFirst: jest.fn().mockResolvedValue({ id: modelId, enabled: true, mediaKind: 'IMAGE', supportsGeneration: true, supportsEdit: false, supportsInpaint: false, resolutionTiers: [{ label: '1K', shortEdge: 1024 }, { label: '2K', shortEdge: 1440 }], allowedRatios: ['1:1'], allowedQualities: ['standard'], maxImages: 1, maxInputImages: 1, defaults: { size: '1024x1024', quality: 'standard', count: 1 }, costPerUnit: 1, pointMultipliers: { '1K': 1, '2K': 2 }, provider: { name: 'provider' } }) },
      asset: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((callback: any) => callback(transaction)),
    };
    const createQuota: any = { reserveJobInTransaction: jest.fn().mockResolvedValue(undefined) };
    const createController = new GenerationsController(createPrisma, queue, queue, limits, createQuota, assets, lifecycle, events);

    await createController.create(user, { modelId, prompt: 'a tall building', size: '1440x1440', count: 1 });

    expect(createQuota.reserveJobInTransaction).toHaveBeenCalledWith(transaction, user, 2, expect.objectContaining({ jobId: 'job-1', kind: 'SUBMIT', imageCount: 1, videoSeconds: 0 }));
  });

  function videoCreateSetup(overrides: Record<string, unknown> = {}) {
    const modelId = '11111111-1111-4111-8111-111111111111';
    const transaction: any = {
      conversation: { create: jest.fn().mockResolvedValue({ id: 'conversation-1' }) },
      promptEntry: { upsert: jest.fn().mockResolvedValue({}) },
      generationJob: { create: jest.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }) },
      asset: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const createPrisma: any = {
      model: { findFirst: jest.fn().mockResolvedValue({
        id: modelId, enabled: true, mediaKind: 'VIDEO', supportsGeneration: true, supportsEdit: true, supportsFirstLastFrame: true, supportsInpaint: false,
        allowedSizes: ['16:9'], allowedQualities: ['720P'], allowedDurations: [5], maxImages: 1, maxInputImages: 2,
        defaults: { size: '16:9', quality: '720P', count: 1, durationSeconds: 5 }, costPerUnit: 1, provider: { name: 'provider' },
        ...overrides,
      }) },
      asset: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((callback: any) => callback(transaction)),
    };
    const createQuota: any = { reserveJobInTransaction: jest.fn().mockResolvedValue(undefined) };
    return { modelId, transaction, createPrisma, createQuota, controller: new GenerationsController(createPrisma, queue, queue, limits, createQuota, assets, lifecycle, events) };
  }

  it('rejects first-last-frame video when the model does not support it', async () => {
    const { modelId, controller } = videoCreateSetup({ supportsFirstLastFrame: false });
    await expect(controller.create(user, { modelId, prompt: 'a pan', mode: 'FIRST_LAST_FRAME_TO_VIDEO', durationSeconds: 5, sourceAssetIds: ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'] })).rejects.toThrow('模型不支持首尾帧');
  });

  it('requires both first and last frames', async () => {
    const firstId = '22222222-2222-4222-8222-222222222222';
    const { modelId, createPrisma, controller } = videoCreateSetup();
    createPrisma.asset.findMany.mockResolvedValue([{ id: firstId }]);
    await expect(controller.create(user, { modelId, prompt: 'a pan', mode: 'FIRST_LAST_FRAME_TO_VIDEO', durationSeconds: 5, sourceAssetIds: [firstId] })).rejects.toThrow('首尾帧必须提供首帧和尾帧');
  });

  it('keeps first and last frame order when creating a video job', async () => {
    const firstId = '22222222-2222-4222-8222-222222222222';
    const lastId = '33333333-3333-4333-8333-333333333333';
    const { modelId, transaction, createPrisma, createQuota, controller } = videoCreateSetup();
    createPrisma.asset.findMany.mockResolvedValue([{ id: firstId }, { id: lastId }]);

    await controller.create(user, { modelId, prompt: 'a pan from dawn to dusk', mode: 'FIRST_LAST_FRAME_TO_VIDEO', durationSeconds: 5, sourceAssetIds: [lastId, firstId] });

    expect(transaction.generationJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mode: 'FIRST_LAST_FRAME_TO_VIDEO',
        parameters: expect.objectContaining({ sourceAssetIds: [lastId, firstId] }),
      }),
    }));
    expect(createQuota.reserveJobInTransaction).toHaveBeenCalledWith(transaction, user, 5, expect.objectContaining({ jobId: 'job-1', kind: 'SUBMIT', imageCount: 0, videoSeconds: 5 }));
  });

  it('allows the same image as both first and last frame', async () => {
    const frameId = '22222222-2222-4222-8222-222222222222';
    const { modelId, transaction, createPrisma, controller } = videoCreateSetup();
    createPrisma.asset.findMany.mockResolvedValue([{ id: frameId }]);

    await controller.create(user, { modelId, prompt: 'hold on the same frame', mode: 'FIRST_LAST_FRAME_TO_VIDEO', durationSeconds: 5, sourceAssetIds: [frameId, frameId] });

    expect(transaction.generationJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ parameters: expect.objectContaining({ sourceAssetIds: [frameId, frameId] }) }),
    }));
  });

  it('uses the first ten characters of a Chinese prompt and the first four words of an English prompt', () => {
    expect(conversationTitleFromPrompt('雨夜霓虹街头的长镜头里')).toBe('雨夜霓虹街头的长镜头');
    expect(conversationTitleFromPrompt('短题')).toBe('短题');
    expect(conversationTitleFromPrompt('a cinematic wide shot of neon rain')).toBe('a cinematic wide shot');
    expect(conversationTitleFromPrompt('combine these images')).toBe('combine these images');
    expect(conversationTitleFromPrompt('', '水彩绘本')).toBe('水彩绘本转绘');
    expect(conversationTitleFromPrompt('   ')).toBe('新创作');
  });

  function imageCreateSetup(overrides: Record<string, unknown> = {}) {
    const modelId = '11111111-1111-4111-8111-111111111111';
    const transaction: any = {
      conversation: { create: jest.fn().mockResolvedValue({ id: 'conversation-1' }) },
      promptEntry: { upsert: jest.fn().mockResolvedValue({}) },
      generationJob: { create: jest.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }) },
      asset: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const createPrisma: any = {
      model: { findFirst: jest.fn().mockResolvedValue({
        id: modelId, enabled: true, mediaKind: 'IMAGE', supportsGeneration: true, supportsEdit: true, supportsInpaint: true,
        resolutionTiers: [{ label: '1K', shortEdge: 1024 }], allowedRatios: ['1:1'], allowedQualities: ['standard'],
        maxImages: 1, maxInputImages: 2, defaults: { size: '1024x1024', quality: 'standard', count: 1 }, costPerUnit: 1, provider: { name: 'provider' },
        ...overrides,
      }) },
      stylePreset: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => STYLE_PRESETS.find((item) => item.id === where.id) ?? null) },
      asset: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((callback: any) => callback(transaction)),
    };
    const createQuota: any = { reserveJobInTransaction: jest.fn().mockResolvedValue(undefined) };
    return { modelId, transaction, createPrisma, controller: new GenerationsController(createPrisma, queue, queue, limits, createQuota, assets, lifecycle, events) };
  }

  it('stores a style preset id without rewriting the user prompt', async () => {
    const { modelId, transaction, controller } = imageCreateSetup();
    await controller.create(user, { modelId, prompt: '一只橘猫', stylePresetId: 'cinematic' });
    expect(transaction.generationJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        prompt: '一只橘猫',
        parameters: expect.objectContaining({
          stylePresetId: 'cinematic',
          styleSuffix: STYLE_PRESETS.find((item) => item.id === 'cinematic')!.suffix,
        }),
      }),
    }));
    expect(transaction.promptEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_promptHash: { userId: 'user-1', promptHash: expect.stringMatching(/^[0-9a-f]{64}$/) } },
    }));
  });

  it('allows empty image-edit prompts when a style preset is selected', async () => {
    const sourceId = '22222222-2222-4222-8222-222222222222';
    const { modelId, transaction, createPrisma, controller } = imageCreateSetup();
    createPrisma.asset.findMany.mockResolvedValue([{ id: sourceId }]);
    await controller.create(user, { modelId, prompt: '', mode: 'IMAGE_EDIT', sourceAssetIds: [sourceId], stylePresetId: 'figurine' });
    expect(transaction.promptEntry.upsert).not.toHaveBeenCalled();
    expect(transaction.conversation.create).toHaveBeenCalledWith({ data: { userId: 'user-1', title: '3D 手办转绘' } });
    expect(transaction.generationJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ prompt: '', parameters: expect.objectContaining({ stylePresetId: 'figurine' }) }),
    }));
  });

  it('rejects unknown style presets and presets on unsupported modes', async () => {
    const { modelId, controller } = imageCreateSetup();
    await expect(controller.create(user, { modelId, prompt: '一只橘猫', stylePresetId: 'ghibli' })).rejects.toThrow('风格预设无效');
    await expect(controller.create(user, { modelId, prompt: '一只橘猫', mode: 'INPAINT', stylePresetId: 'cinematic' })).rejects.toThrow('当前模式不支持风格预设');
    await expect(controller.create(user, { modelId, prompt: '', mode: 'TEXT_TO_IMAGE' })).rejects.toThrow('提示词长度必须为 1-8000 字符');
  });

  it('returns the stored style preset on reuse', async () => {
    prisma.generationJob.findFirst.mockResolvedValue({
      modelId: 'model-1', mode: 'TEXT_TO_IMAGE', prompt: '一只橘猫',
      parameters: { size: '1024x1024', quality: 'standard', count: 1, stylePresetId: 'storybook' },
      modelSnapshot: { displayName: 'Painter' },
    });
    prisma.asset.findMany.mockResolvedValue([]);
    const result = await controller.reuse(user, 'job-1');
    expect(result).toMatchObject({ prompt: '一只橘猫', stylePresetId: 'storybook' });
  });

  it('requires every original reference to still exist before reuse', async () => {
    prisma.generationJob.findFirst.mockResolvedValue({ modelId: 'model-1', mode: 'INPAINT', prompt: 'edit', parameters: { sourceAssetIds: ['source-1'] }, modelSnapshot: { displayName: 'Editor' } });
    prisma.asset.findMany.mockResolvedValue([]);

    await expect(controller.reuse(user, 'job-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('releases the SSE quota and performs no database polling while idle', async () => {
    jest.useFakeTimers();
    let listener: ((job: any) => void) | undefined;
    const release = jest.fn().mockResolvedValue(undefined);
    const unsubscribe = jest.fn().mockResolvedValue(undefined);
    quota.acquireSse.mockResolvedValue(release);
    events.subscribe.mockImplementation(async (_userId: string, callback: (job: any) => void) => { listener = callback; return unsubscribe; });
    const completedJob = { id: 'job-1', conversationId: 'conversation-1', status: 'SUCCEEDED', mode: 'TEXT_TO_IMAGE', prompt: 'done', errorMessage: null, parameters: {}, modelSnapshot: {}, assets: [] };
    const subscription = controller.events(user).subscribe();

    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(60_000);
    expect(prisma.generationJob.findFirst).not.toHaveBeenCalled();
    listener?.(completedJob);
    await Promise.resolve();
    expect(prisma.generationJob.findFirst).not.toHaveBeenCalled();
    subscription.unsubscribe();
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('releases SSE quota when the client disconnects before acquisition resolves', async () => {
    let resolveAcquire!: (release: () => Promise<void>) => void;
    const release = jest.fn().mockResolvedValue(undefined);
    quota.acquireSse.mockReturnValue(new Promise((resolve) => { resolveAcquire = resolve; }));

    const subscription = controller.events(user).subscribe();
    subscription.unsubscribe();
    resolveAcquire(release);
    await Promise.resolve();
    await Promise.resolve();

    expect(release).toHaveBeenCalledTimes(1);
    expect(prisma.generationJob.findFirst).not.toHaveBeenCalled();
  });
});
