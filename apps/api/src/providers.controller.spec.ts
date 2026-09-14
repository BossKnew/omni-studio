import { HttpException } from '@nestjs/common';
import { ProvidersController } from './providers.controller';

function fetchHttp() {
  return {
    validateBaseUrl: (value: unknown) => String(value).replace(/\/$/, ''),
    request: async (url: string, init: any) => {
      const response = await fetch(url, init);
      const body = typeof (response as any).arrayBuffer === 'function' ? Buffer.from(await response.arrayBuffer()) : Buffer.from('{"data":[]}');
      return { ok: response.ok, status: response.status, headers: response.headers ?? new Headers({ 'content-type': 'application/json' }), body, url };
    },
  };
}

describe('ProvidersController', () => {
  const originalFetch = global.fetch;
  let prisma: any;
  let controller: ProvidersController;

  beforeEach(() => {
    prisma = {
      provider: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
      model: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    controller = new ProvidersController(prisma, { decrypt: jest.fn(() => 'secret'), encrypt: jest.fn((value) => `encrypted:${value}`) } as any, fetchHttp() as any);
  });

  afterEach(() => { global.fetch = originalFetch; });

  it('persists a 120 second cooldown and successful test result', async () => {
    prisma.provider.updateMany.mockResolvedValue({ count: 1 });
    prisma.provider.findUniqueOrThrow.mockResolvedValue({ id: 'provider-1', baseUrl: 'https://api.example.com/v1', encryptedApiKey: 'encrypted', encryptedHeaders: null, timeoutSeconds: 30 });
    prisma.provider.update.mockResolvedValue({});
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as any;

    const result = await controller.test('provider-1');

    expect(result).toMatchObject({ ok: true, status: 200, cooldownUntil: expect.any(Date) });
    expect(result.cooldownUntil.getTime()).toBeGreaterThan(Date.now() + 115_000);
    expect(prisma.provider.update).toHaveBeenCalledWith({ where: { id: 'provider-1' }, data: { lastTestOk: true } });
  });

  it('does not treat an HTML website page as a successful API test', async () => {
    prisma.provider.updateMany.mockResolvedValue({ count: 1 });
    prisma.provider.findUniqueOrThrow.mockResolvedValue({ id: 'provider-1', baseUrl: 'https://api.example.com', encryptedApiKey: 'encrypted', encryptedHeaders: null, timeoutSeconds: 30 });
    prisma.provider.update.mockResolvedValue({});
    const http = {
      request: jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: Buffer.from('<html>website</html>') }),
    };
    controller = new ProvidersController(prisma, { decrypt: jest.fn(() => 'secret') } as any, http as any);

    const result = await controller.test('provider-1');

    expect(result).toMatchObject({ ok: false, status: 200, error: expect.stringContaining('/v1') });
    expect(http.request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirectPolicy: 'same-origin' }), expect.any(Number));
    expect(prisma.provider.update).toHaveBeenCalledWith({ where: { id: 'provider-1' }, data: { lastTestOk: false } });
  });

  it('rejects another test while the persisted cooldown is active', async () => {
    prisma.provider.updateMany.mockResolvedValue({ count: 0 });
    prisma.provider.findUniqueOrThrow.mockResolvedValue({ testCooldownUntil: new Date(Date.now() + 90_000) });

    await expect(controller.test('provider-1')).rejects.toMatchObject({ status: 429 } as Partial<HttpException>);
    expect(global.fetch).toBe(originalFetch);
  });

  it('permanently deletes a provider and its models when no task is active', async () => {
    const transaction = {
      generationJob: { count: jest.fn().mockResolvedValue(0) },
      model: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      provider: { delete: jest.fn().mockResolvedValue({ id: 'provider-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((callback: any) => callback(transaction));

    await expect(controller.remove({ id: 'admin-1' } as any, 'provider-1')).resolves.toEqual({ ok: true });
    expect(transaction.model.deleteMany).toHaveBeenCalledWith({ where: { providerId: 'provider-1' } });
    expect(transaction.provider.delete).toHaveBeenCalledWith({ where: { id: 'provider-1' } });
  });

  it('rejects custom headers that can alter routing or authentication', async () => {
    await expect(controller.create({ id: 'admin-1' } as any, {
      name: 'unsafe', baseUrl: 'https://api.example.com/v1', apiKey: 'secret', headers: { Host: 'metadata.internal' },
    })).rejects.toBeInstanceOf(HttpException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects adapterKind on the provider payload', async () => {
    await expect(controller.create({ id: 'admin-1' } as any, {
      name: 'typed', baseUrl: 'https://api.example.com/v1', apiKey: 'secret', adapterKind: 'openai-images',
    })).rejects.toBeInstanceOf(HttpException);
  });

  it('probes each distinct model adapter when testing a provider', async () => {
    prisma.provider.updateMany.mockResolvedValue({ count: 1 });
    prisma.provider.findUniqueOrThrow.mockResolvedValue({
      id: 'provider-1', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', encryptedApiKey: 'encrypted', encryptedHeaders: null, timeoutSeconds: 30, pollTimeoutSeconds: 900,
    });
    prisma.provider.update.mockResolvedValue({});
    prisma.model.findMany.mockResolvedValue([{ adapterKind: 'qwen-image' }, { adapterKind: 'wan' }]);
    const http = {
      request: jest.fn().mockResolvedValue({ ok: true, status: 404, headers: new Headers({ 'content-type': 'application/json' }), body: Buffer.from('{}') }),
    };
    controller = new ProvidersController(prisma, { decrypt: jest.fn(() => 'secret') } as any, http as any);

    const result = await controller.test('provider-1');

    expect(result).toMatchObject({ ok: true, status: 404 });
    const urls = http.request.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls.some((url: string) => url.endsWith('/tasks/0'))).toBe(true);
    expect(urls.filter((url: string) => url.endsWith('/tasks/0'))).toHaveLength(2);
  });
});
