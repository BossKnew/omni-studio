import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { encodeCursor } from './pagination';

describe('AssetsController', () => {
  const user = { id: 'user-1', role: 'USER', username: 'alice' } as any;
  let prisma: any;
  let storage: any;
  let lifecycle: any;
  let controller: AssetsController;

  beforeEach(() => {
    delete process.env.MEDIA_X_ACCEL_REDIRECT;
    prisma = {
      asset: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    storage = { normalizeImageFile: jest.fn(), saveStaged: jest.fn(), deleteStaged: jest.fn(), delete: jest.fn() };
    lifecycle = { persistNormalized: jest.fn(), remove: jest.fn(), restore: jest.fn(), purge: jest.fn(), emptyTrash: jest.fn() };
    controller = new AssetsController(prisma, storage, lifecycle);
  });

  it('stores generated masks with the MASK role so they stay out of the asset library', async () => {
    const file = { path: 'staging/upload', size: 3, mimetype: 'image/png', originalname: 'mask.png' } as Express.Multer.File;
    storage.normalizeImageFile.mockResolvedValue({ path: 'staging/normalized', sizeBytes: 3n, mimeType: 'image/png', width: 1024, height: 1024 });
    lifecycle.persistNormalized.mockResolvedValue({ id: 'mask-1', role: 'MASK', objectKey: 'user-1/mask.png', sizeBytes: 3n, deletedAt: null, note: null, thumbnail: null });

    await controller.upload(user, { role: 'MASK' }, file);

    expect(storage.normalizeImageFile).toHaveBeenCalledWith('staging/upload', 'image/png', { thumbnail: false, maxLongEdge: 4096, mask: true });
    expect(lifecycle.persistNormalized).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', role: 'MASK', originalName: 'mask.png' }));
  });

  it('passes the configured upload max long edge into image normalization', async () => {
    const file = { path: 'staging/upload', size: 3, mimetype: 'image/jpeg', originalname: 'photo.jpg' } as Express.Multer.File;
    prisma.systemSetting.findUnique.mockResolvedValue({ value: { maxLongEdge: 2048 } });
    storage.normalizeImageFile.mockResolvedValue({ path: 'staging/normalized', sizeBytes: 3n, mimeType: 'image/jpeg', width: 2048, height: 1536 });
    lifecycle.persistNormalized.mockResolvedValue({ id: 'asset-1', role: 'UPLOAD', objectKey: 'user-1/photo.jpg', sizeBytes: 3n, deletedAt: null, note: null, thumbnail: null });

    await controller.upload(user, {}, file);

    expect(storage.normalizeImageFile).toHaveBeenCalledWith('staging/upload', 'image/jpeg', { thumbnail: true, maxLongEdge: 2048, mask: false });
  });

  it('trims and saves a note only after confirming ownership', async () => {
    prisma.asset.findFirst.mockResolvedValue({ id: 'asset-1' });
    prisma.asset.update.mockResolvedValue({ id: 'asset-1', note: '旅行灵感' });

    await expect(controller.updateNote(user, 'asset-1', { note: '  旅行灵感  ' })).resolves.toEqual({ id: 'asset-1', note: '旅行灵感' });
    expect(prisma.asset.findFirst).toHaveBeenCalledWith({ where: { id: 'asset-1', userId: 'user-1', deletedAt: null }, select: { id: true } });
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: 'asset-1' }, data: { note: '旅行灵感' }, select: { id: true, note: true } });
  });

  it('stores a cleared note as null', async () => {
    prisma.asset.findFirst.mockResolvedValue({ id: 'asset-1' });
    prisma.asset.update.mockResolvedValue({ id: 'asset-1', note: null });
    await controller.updateNote(user, 'asset-1', { note: '   ' });
    expect(prisma.asset.update).toHaveBeenCalledWith(expect.objectContaining({ data: { note: null } }));
  });

  it('rejects invalid or oversized notes', async () => {
    await expect(controller.updateNote(user, 'asset-1', { note: 123 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.updateNote(user, 'asset-1', { note: 'x'.repeat(1001) })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.asset.findFirst).not.toHaveBeenCalled();
  });

  it('does not update an asset owned by another user', async () => {
    prisma.asset.findFirst.mockResolvedValue(null);
    await expect(controller.updateNote(user, 'other-asset', { note: 'private' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it('returns notes and generation prompts without exposing storage keys', async () => {
    prisma.asset.findMany.mockResolvedValue([{
      id: 'asset-1', userId: 'user-1', role: 'OUTPUT', objectKey: 'user-1/private.png', mimeType: 'image/png',
      sizeBytes: 4096n, width: 1024, height: 1024, originalName: null, note: '封面候选', contentHash: 'private-sha256', createdAt: new Date(), job: { prompt: '雨夜城市' },
    }]);
    prisma.asset.count = jest.fn().mockResolvedValue(1);
    const result = await controller.list(user);
    expect(result.items[0]).toMatchObject({ id: 'asset-1', note: '封面候选', generationPrompt: '雨夜城市', visibility: 'owned', sharedTeamIds: [], sizeBytes: '4096', contentUrl: '/api/v1/assets/asset-1/content?v=private-sha256', thumbnailUrl: null, thumbnailWidth: null, thumbnailHeight: null });
    expect(result.items[0].objectKey).toBeUndefined();
    expect(result.items[0].contentHash).toBeUndefined();
    expect((result.items[0] as any).job).toBeUndefined();
    expect(result.total).toBe(1);
  });

  it('lists owned assets with filters and counts without the cursor', async () => {
    prisma.asset.findMany.mockResolvedValue([]);
    prisma.asset.count = jest.fn().mockResolvedValue(0);
    const from = '2026-08-01T00:00:00.000Z';
    const to = '2026-08-28T00:00:00.000Z';
    const modelId = '11111111-1111-4111-8111-111111111111';
    await controller.list(user, { mediaKind: 'IMAGE', role: 'OUTPUT', q: '封面', modelId, from, to });
    const filterWhere = {
      deletedAt: null,
      role: 'OUTPUT',
      mediaKind: 'IMAGE',
      createdAt: { gte: new Date(from), lt: new Date(to) },
      AND: [
        { job: { modelId } },
        { OR: [
          { note: { contains: '封面', mode: 'insensitive' } },
          { job: { prompt: { contains: '封面', mode: 'insensitive' } } },
        ] },
      ],
    };
    expect(prisma.asset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', AND: [filterWhere, {}] },
    }));
    expect(prisma.asset.count).toHaveBeenCalledWith({ where: { userId: 'user-1', ...filterWhere } });
  });

  it('skips the total count on subsequent cursor pages', async () => {
    prisma.asset.findMany.mockResolvedValue([]);
    prisma.asset.count = jest.fn();
    const cursor = encodeCursor(new Date('2026-08-17T00:00:00.000Z'), '123e4567-e89b-42d3-a456-426614174000');
    const result = await controller.list(user, { cursor });
    expect(result.total).toBeUndefined();
    expect(prisma.asset.count).not.toHaveBeenCalled();
  });

  it('rejects an invalid owned-library filter', async () => {
    await expect(controller.list(user, { mediaKind: 'AUDIO' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it('allows only private caching for authenticated asset content', async () => {
    prisma.asset.findFirst.mockResolvedValue({ id: 'asset-1', userId: 'user-1', role: 'OUTPUT', deletedAt: null, shares: [], objectKey: 'user-1/private.png', mimeType: 'image/png', sizeBytes: 3n });
    const stream = { on: jest.fn().mockReturnThis(), pipe: jest.fn() };
    storage.createReadStream = jest.fn(() => stream);
    const response = { setHeader: jest.fn(), destroy: jest.fn() } as any;

    await controller.content(user, 'asset-1', response);

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=3600');
    expect(response.setHeader).toHaveBeenCalledWith('ETag', '"asset-1-3"');
    expect(response.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(stream.pipe).toHaveBeenCalledWith(response);
  });

  it('returns 304 when the client already has the fingerprinted bytes', async () => {
    prisma.asset.findFirst.mockResolvedValue({
      id: 'asset-1', userId: 'user-1', role: 'OUTPUT', deletedAt: null, shares: [],
      objectKey: 'user-1/private.png', mimeType: 'image/png', sizeBytes: 3n, contentHash: 'deadbeef',
    });
    const response = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), end: jest.fn(), destroy: jest.fn() } as any;
    await controller.content(user, 'asset-1', response, { headers: { 'if-none-match': '"deadbeef"' } } as any);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=31536000, immutable');
    expect(response.status).toHaveBeenCalledWith(304);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(storage.createReadStream).toBeUndefined();
  });

  it('serves byte ranges for video seeking', async () => {
    prisma.asset.findFirst.mockResolvedValue({ id: 'asset-1', userId: 'user-1', role: 'OUTPUT', deletedAt: null, shares: [], objectKey: 'user-1/clip.mp4', mimeType: 'video/mp4', sizeBytes: 100n });
    const stream = { on: jest.fn().mockReturnThis(), pipe: jest.fn() };
    storage.createReadStream = jest.fn(() => stream);
    const response = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), destroy: jest.fn() } as any;

    await controller.content(user, 'asset-1', response, { headers: { range: 'bytes=0-9' } } as any);

    expect(response.status).toHaveBeenCalledWith(206);
    expect(response.setHeader).toHaveBeenCalledWith('Content-Range', 'bytes 0-9/100');
    expect(storage.createReadStream).toHaveBeenCalledWith('user-1/clip.mp4', { start: 0, end: 9 });
  });

  it('offloads authenticated media to the internal Nginx location in production', async () => {
    process.env.MEDIA_X_ACCEL_REDIRECT = 'true';
    prisma.asset.findFirst.mockResolvedValue({ id: 'asset-1', userId: 'user-1', role: 'OUTPUT', deletedAt: null, shares: [], objectKey: 'user-1/private image.png', mimeType: 'image/png', sizeBytes: 3n });
    const response = { setHeader: jest.fn(), end: jest.fn() } as any;

    await controller.content(user, 'asset-1', response);

    expect(response.setHeader).toHaveBeenCalledWith('X-Accel-Redirect', '/_protected_media/user-1/private%20image.png');
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(storage.createReadStream).toBeUndefined();
  });

  it('serves one-byte range probes from Node even when Nginx acceleration is enabled', async () => {
    process.env.MEDIA_X_ACCEL_REDIRECT = 'true';
    prisma.asset.findFirst.mockResolvedValue({ id: 'asset-1', userId: 'user-1', role: 'OUTPUT', deletedAt: null, shares: [], objectKey: 'user-1/clip.mp4', mimeType: 'video/mp4', sizeBytes: 100n });
    const stream = { on: jest.fn().mockReturnThis(), pipe: jest.fn() };
    storage.createReadStream = jest.fn(() => stream);
    const response = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), destroy: jest.fn(), end: jest.fn() } as any;

    await controller.content(user, 'asset-1', response, { headers: { range: 'bytes=0-0' } } as any);

    expect(response.status).toHaveBeenCalledWith(206);
    expect(response.setHeader).not.toHaveBeenCalledWith('X-Accel-Redirect', expect.anything());
    expect(storage.createReadStream).toHaveBeenCalledWith('user-1/clip.mp4', { start: 0, end: 0 });
    expect(response.end).not.toHaveBeenCalled();
  });

  it('moves a library asset into trash', async () => {
    lifecycle.remove.mockResolvedValue({ id: 'asset-1' });

    await expect(controller.remove(user, 'asset-1')).resolves.toEqual({ ok: true });

    expect(lifecycle.remove).toHaveBeenCalledWith('user-1', 'asset-1');
  });

  it('restores and permanently purges trash items through the lifecycle', async () => {
    lifecycle.restore.mockResolvedValue({ id: 'asset-1' });
    lifecycle.purge.mockResolvedValue({ id: 'asset-1' });
    lifecycle.emptyTrash.mockResolvedValue(2);
    await expect(controller.restore(user, 'asset-1')).resolves.toEqual({ ok: true });
    await expect(controller.purge(user, 'asset-1')).resolves.toEqual({ ok: true });
    await expect(controller.emptyTrash(user)).resolves.toEqual({ ok: true, purged: 2 });
  });

  it('lets the owner read trashed content until it is purged', async () => {
    prisma.asset.findFirst.mockResolvedValue({
      id: 'asset-1', userId: 'user-1', role: 'OUTPUT', deletedAt: new Date(), purgedAt: null, shares: [],
      objectKey: 'user-1/trashed.png', mimeType: 'image/png', sizeBytes: 3n, thumbnailFor: null,
    });
    const stream = { on: jest.fn().mockReturnThis(), pipe: jest.fn() };
    storage.createReadStream = jest.fn(() => stream);
    const response = { setHeader: jest.fn(), destroy: jest.fn() } as any;
    await controller.content(user, 'asset-1', response);
    expect(prisma.asset.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'asset-1', purgedAt: null } }));
    expect(stream.pipe).toHaveBeenCalledWith(response);
  });

  it('hides unshared private content from other users and administrators', async () => {
    prisma.asset.findFirst.mockResolvedValue({ id: 'asset-1', userId: 'owner-1', role: 'OUTPUT', deletedAt: null, shares: [], objectKey: 'owner-1/private.png', mimeType: 'image/png', sizeBytes: 3n, thumbnailFor: null });
    const response = { setHeader: jest.fn() } as any;
    await expect(controller.content({ id: 'member-1', role: 'USER', teamIds: ['design'] } as any, 'asset-1', response)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.content({ id: 'admin-1', role: 'ADMIN', teamIds: [] } as any, 'asset-1', response)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.createReadStream).toBeUndefined();
  });

  it('lets a current team member read shared content', async () => {
    prisma.asset.findFirst.mockResolvedValue({
      id: 'asset-1', userId: 'owner-1', role: 'OUTPUT', deletedAt: null, shares: [{ teamId: 'design' }],
      objectKey: 'owner-1/shared.png', mimeType: 'image/png', sizeBytes: 3n, thumbnailFor: null,
    });
    const stream = { on: jest.fn().mockReturnThis(), pipe: jest.fn() };
    storage.createReadStream = jest.fn(() => stream);
    const response = { setHeader: jest.fn(), destroy: jest.fn() } as any;
    await controller.content({ id: 'member-1', role: 'USER', teamIds: ['design'] } as any, 'asset-1', response);
    expect(stream.pipe).toHaveBeenCalledWith(response);
  });

  it('omits notes and prompts from the team library', async () => {
    prisma.assetShare = {
      findMany: jest.fn().mockResolvedValue([{
        id: 'share-1', createdAt: new Date('2026-08-20T00:00:00.000Z'),
        team: { id: 'design', name: 'Design' },
        sharedBy: { displayName: 'Alice', username: 'alice' },
        asset: { id: 'asset-1', userId: 'owner-1', role: 'OUTPUT', mimeType: 'image/png', sizeBytes: 4n, width: 10, height: 10, deletedAt: null, objectKey: 'owner/secret.png', note: 'secret', thumbnail: null },
      }]),
      count: jest.fn().mockResolvedValue(1),
    };
    const result = await controller.shared({ id: 'member-1', role: 'USER', teamIds: ['design'] } as any);
    expect(result.items[0]).toMatchObject({
      id: 'asset-1', visibility: 'shared', note: null, generationPrompt: null,
      team: { id: 'design', name: 'Design' }, sharedBy: { displayName: 'Alice' }, canUnshare: false,
      contentUrl: '/api/v1/assets/asset-1/content',
    });
    expect((result.items[0] as any).objectKey).toBeUndefined();
  });

  it('filters the team library through the nested asset where and rejects keywords', async () => {
    prisma.assetShare = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    await controller.shared({ id: 'member-1', role: 'USER', teamIds: ['design'] } as any, { mediaKind: 'VIDEO', role: 'UPLOAD' });
    expect(prisma.assetShare.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        teamId: { in: ['design'] },
        asset: { deletedAt: null, role: 'UPLOAD', mediaKind: 'VIDEO' },
      }),
    }));
    await expect(controller.shared({ id: 'member-1', role: 'USER', teamIds: ['design'] } as any, { q: 'secret' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets only the owner replace share targets', async () => {
    const teamId = '11111111-1111-4111-8111-111111111111';
    prisma.asset.findFirst.mockResolvedValue({ id: 'asset-1', userId: 'owner-1', role: 'OUTPUT', deletedAt: null });
    await expect(controller.replaceShares({ id: 'member-1', role: 'USER', teamIds: [teamId] } as any, 'asset-1', { teamIds: [teamId] })).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.replaceShares({ id: 'admin-1', role: 'ADMIN', teamIds: [] } as any, 'asset-1', { teamIds: [teamId] })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets an administrator unshare another user\'s asset', async () => {
    const teamId = '11111111-1111-4111-8111-111111111111';
    prisma.asset.findFirst.mockResolvedValue({ id: 'asset-1', userId: 'owner-1', deletedAt: null });
    prisma.assetShare = { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) };
    prisma.auditLog = { create: jest.fn().mockResolvedValue({}) };
    await expect(controller.unshare({ id: 'admin-1', role: 'ADMIN', teamIds: [] } as any, 'asset-1', teamId)).resolves.toEqual({ ok: true });
    expect(prisma.assetShare.deleteMany).toHaveBeenCalledWith({ where: { assetId: 'asset-1', teamId } });
  });
});
