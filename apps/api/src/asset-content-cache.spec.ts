import { AssetContentCache } from './asset-content-cache';

describe('AssetContentCache', () => {
  const row = {
    id: 'asset-1', objectKey: 'user-1/a.png', mimeType: 'image/png', sizeBytes: 3n, contentHash: 'abc',
    userId: 'user-1', role: 'OUTPUT', deletedAt: null, purgedAt: null, shares: [{ teamId: 'design' }], thumbnailFor: null,
  };

  it('serves a second lookup from Redis without querying Prisma', async () => {
    const prisma = { asset: { findFirst: jest.fn().mockResolvedValue(row) } } as any;
    const store = new Map<string, string>();
    const redis = { client: {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
      del: jest.fn(async (...keys: string[]) => { for (const key of keys) store.delete(key); return keys.length; }),
    } } as any;
    const cache = new AssetContentCache(prisma, redis);

    const first = await cache.get('asset-1');
    const second = await cache.get('asset-1');
    expect(first).toMatchObject({ id: 'asset-1', userId: 'user-1', sizeBytes: 3n, shares: [{ teamId: 'design' }] });
    expect(second).toEqual(first);
    expect(prisma.asset.findFirst).toHaveBeenCalledTimes(1);
  });

  it('drops cached rows so a share change is visible on the next request', async () => {
    const prisma = { asset: { findFirst: jest.fn().mockResolvedValue(row) } } as any;
    const store = new Map<string, string>([['asset-content:v1:asset-1', '{"stale":true}']]);
    const redis = { client: {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(),
      del: jest.fn(async (...keys: string[]) => { for (const key of keys) store.delete(key); return keys.length; }),
    } } as any;
    const cache = new AssetContentCache(prisma, redis);
    await cache.invalidate(['asset-1', 'thumb-1']);
    expect(store.size).toBe(0);
    expect(redis.client.del).toHaveBeenCalledWith('asset-content:v1:asset-1', 'asset-content:v1:thumb-1');
  });
});
