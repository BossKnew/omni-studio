import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import { Request } from 'undici';
import { GenerationProcessor, chatImageCompletionBody, extractChatImageRefs, normalizeImageQuality, parseChatCompletionImages, parseProviderImages, providerEditImageField, providerErrorCode, providerErrorFingerprint, providerHttpFailure, providerImageParameters, providerPromptFromJob } from './generation.processor';
import { StorageService } from './storage.service';

async function stageAndSave(storage: StorageService, userId: string, buffer: Buffer, mimeType: string) {
  const stagedPath = await storage.createStagingPath('.png');
  await writeFile(stagedPath, buffer, { flag: 'wx' });
  return storage.saveStaged(userId, stagedPath, mimeType);
}

describe('image request compatibility', () => {
  it('maps the legacy standard quality to auto for GPT Image models', () => {
    expect(normalizeImageQuality('gpt-image-2', 'standard')).toBe('auto');
    expect(normalizeImageQuality('gpt-image-1', 'standard')).toBe('auto');
    expect(normalizeImageQuality('openai/gpt-image-1', 'standard')).toBe('auto');
  });

  it('does not alter quality values for other image models', () => {
    expect(normalizeImageQuality('dall-e-3', 'standard')).toBe('standard');
    expect(normalizeImageQuality('gpt-image-2', 'high')).toBe('high');
  });

  it('maps upstream status codes to stable, non-secret diagnostics', () => {
    expect(providerHttpFailure(401).code).toBe('PROVIDER_AUTH');
    expect(providerHttpFailure(400).code).toBe('PROVIDER_PARAMETERS');
    expect(providerHttpFailure(429).code).toBe('PROVIDER_LIMIT');
    expect(providerHttpFailure(503).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('uses only a bounded provider error code for actionable diagnostics', () => {
    const invalidMask = Buffer.from(JSON.stringify({ error: { code: 'invalid_mask', message: 'sensitive upstream detail' } }));
    expect(providerErrorCode(invalidMask)).toBe('invalid_mask');
    expect(providerHttpFailure(400, invalidMask)).toEqual(expect.objectContaining({
      code: 'PROVIDER_PARAMETERS',
      message: expect.stringContaining('invalid_mask'),
    }));
    expect(providerHttpFailure(400, Buffer.from(JSON.stringify({ error: { code: 'moderation_blocked' } })))).toEqual(expect.objectContaining({ code: 'PROVIDER_MODERATION' }));
    expect(providerHttpFailure(400, Buffer.from(JSON.stringify({ error: { code: 'text_conversation_not_supported' } })))).toEqual(expect.objectContaining({
      code: 'PROVIDER_PARAMETERS',
      message: expect.stringContaining('text_conversation_not_supported'),
    }));
    expect(providerErrorCode(Buffer.from(JSON.stringify({ error: { code: 'unsafe code with spaces' } })))).toBeUndefined();
    expect(providerErrorCode(Buffer.from('not json'))).toBeUndefined();
  });

  it('does not send the legacy response_format parameter to providers', () => {
    const parameters = providerImageParameters('gpt-image-1', 'test', { size: '1024x1024', quality: 'high', count: 1 });
    expect(parameters).toEqual({ model: 'gpt-image-1', prompt: 'test', size: '1024x1024', quality: 'high', n: 1 });
    expect(parameters).not.toHaveProperty('response_format');
  });

  it('uses image for a single edit source and image[] for multiple sources', () => {
    expect(providerEditImageField(1)).toBe('image');
    expect(providerEditImageField(2)).toBe('image[]');
  });

  it('builds a streaming chat-completions payload for image-only models', () => {
    expect(chatImageCompletionBody('gpt-4o-image', 'a cat')).toEqual({
      model: 'gpt-4o-image',
      stream: true,
      messages: [{ role: 'user', content: 'a cat' }],
    });
    expect(chatImageCompletionBody('gpt-4o-image', 'edit this', ['data:image/png;base64,abc'])).toEqual({
      model: 'gpt-4o-image',
      stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'edit this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      }],
    });
  });

  it('extracts chat image refs from markdown, data URLs, and structured fields', () => {
    expect(extractChatImageRefs({
      choices: [{ message: { content: '![image](https://cdn.example.com/out.png)' } }],
    })).toEqual(['https://cdn.example.com/out.png']);
    expect(extractChatImageRefs({
      choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,YWJj' } }] } }],
    })).toEqual(['data:image/png;base64,YWJj']);
    expect(extractChatImageRefs({ data: [{ b64_json: 'YWJjZA==' }] })).toEqual(['data:image/png;base64,YWJjZA==']);
  });

  it('extracts qwen-image result URLs from output.choices message content', () => {
    expect(extractChatImageRefs({
      output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: 'https://dashscope-result.oss-cn-shenzhen.aliyuncs.com/x.png', type: 'image' }] } }] },
    })).toEqual(['https://dashscope-result.oss-cn-shenzhen.aliyuncs.com/x.png']);
  });

  it('extracts Gemini generateContent inlineData images', () => {
    expect(extractChatImageRefs({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } }],
    })).toEqual(['data:image/png;base64,YWJj']);
  });

  it('reduces provider errors to an irreversible fixed-size fingerprint', () => {
    const fingerprint = providerErrorFingerprint(Buffer.from(JSON.stringify({ error: { message: 'leaked sk-secret-value' } })));
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(fingerprint).not.toContain('secret');
    expect(providerErrorFingerprint()).toBe('empty');
  });
});

describe('streamed provider image parsing', () => {
  let root: string;
  let storage: StorageService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'omnistudio-provider-'));
    process.env.MEDIA_ROOT = root;
    storage = new StorageService();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('decodes chunked base64 data to a bounded staging file', async () => {
    const jsonPath = await storage.createStagingPath('.json');
    const image = Buffer.from('streamed-image');
    await writeFile(jsonPath, JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }), { flag: 'wx' });
    const parsed = await parseProviderImages(jsonPath, 1, storage);
    expect(parsed).toHaveLength(1);
    await expect(storage.inspectImageFile(parsed[0].path!)).rejects.toThrow();
    await expect(readFile(parsed[0].path!)).resolves.toEqual(image);
    await storage.deleteStaged(parsed[0].path!);
  });

  it('streams a large chunked string without buffering the decoded image in memory', async () => {
    const jsonPath = await storage.createStagingPath('.json');
    const image = Buffer.alloc(256 * 1024, 0x61);
    await writeFile(jsonPath, JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }), { flag: 'wx' });
    const parsed = await parseProviderImages(jsonPath, 1, storage);
    await expect(readFile(parsed[0].path!)).resolves.toEqual(image);
    await storage.deleteStaged(parsed[0].path!);
  });

  it('rejects malformed base64 without retaining a staging image', async () => {
    const jsonPath = await storage.createStagingPath('.json');
    await writeFile(jsonPath, JSON.stringify({ data: [{ b64_json: 'not*base64' }] }), { flag: 'wx' });
    await expect(parseProviderImages(jsonPath, 1, storage)).rejects.toMatchObject({ providerFailure: { code: 'PROVIDER_RESPONSE' } });
  });

  it('accepts valid unpadded base64 from compatible providers', async () => {
    const jsonPath = await storage.createStagingPath('.json');
    await writeFile(jsonPath, JSON.stringify({ data: [{ b64_json: 'YWJjZA' }] }), { flag: 'wx' });
    const parsed = await parseProviderImages(jsonPath, 1, storage);
    await expect(readFile(parsed[0].path!)).resolves.toEqual(Buffer.from('abcd'));
    await storage.deleteStaged(parsed[0].path!);
  });

  it('supports URL image entries and limits results to the requested count', async () => {
    const jsonPath = await storage.createStagingPath('.json');
    await writeFile(jsonPath, JSON.stringify({ data: [{ url: 'https://cdn.example.com/one.png' }, { url: 'https://cdn.example.com/two.png' }] }), { flag: 'wx' });
    await expect(parseProviderImages(jsonPath, 1, storage)).resolves.toEqual([{ url: 'https://cdn.example.com/one.png' }]);
  });

  it('normalizes malformed JSON and source-file failures to provider response errors', async () => {
    const malformedPath = await storage.createStagingPath('.json');
    await writeFile(malformedPath, '{"data":[', { flag: 'wx' });
    await expect(parseProviderImages(malformedPath, 1, storage)).rejects.toMatchObject({ providerFailure: { code: 'PROVIDER_RESPONSE' } });
    await expect(parseProviderImages(join(root, 'missing.json'), 1, storage)).rejects.toMatchObject({ providerFailure: { code: 'PROVIDER_RESPONSE' } });
  });

  it('decodes streamed chat-completions image markdown into a staging file', async () => {
    const jsonPath = await storage.createStagingPath('.chat');
    const image = Buffer.from('streamed-chat-image');
    await writeFile(jsonPath, `data: {"choices":[{"delta":{"content":"![image](data:image/png;base64,${image.toString('base64')})"}}]}\n\ndata: [DONE]\n`, { flag: 'wx' });
    const parsed = await parseChatCompletionImages(jsonPath, 1, storage);
    expect(parsed).toHaveLength(1);
    await expect(readFile(parsed[0].path!)).resolves.toEqual(image);
    await storage.deleteStaged(parsed[0].path!);
  });

  it('reads OpenRouter-style chat image arrays', async () => {
    const jsonPath = await storage.createStagingPath('.json');
    await writeFile(jsonPath, JSON.stringify({
      choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'https://cdn.example.com/chat.png' } }] } }],
    }), { flag: 'wx' });
    await expect(parseChatCompletionImages(jsonPath, 1, storage)).resolves.toEqual([{ url: 'https://cdn.example.com/chat.png' }]);
  });
});

describe('GenerationProcessor mask lifecycle', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'omnistudio-generation-')); process.env.MEDIA_ROOT = root; });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('deletes the retained mask only after an inpaint job succeeds', async () => {
    const storage = new StorageService();
    const input = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#fff' } }).png().toBuffer();
    const sourceStored = await stageAndSave(storage, 'user-1', input, 'image/png');
    const sourceStored2 = await stageAndSave(storage, 'user-1', input, 'image/png');
    const maskStored = await stageAndSave(storage, 'user-1', input, 'image/png');
    const job = {
      id: 'job-1', userId: 'user-1', status: 'QUEUED', mode: 'INPAINT', user: { status: 'ACTIVE', role: 'USER' },
      model: { upstreamModelId: 'image-model', provider: { baseUrl: 'https://api.example.com/v1', encryptedApiKey: 'encrypted', encryptedHeaders: null, timeoutSeconds: 30 } },
      parameters: { sourceAssetIds: ['source-1', 'source-2'], maskAssetId: 'mask-1', size: '1024x1024', count: 1 }, prompt: 'replace the sky',
    };
    const prisma: any = {
      generationJob: { findUnique: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({ status: 'RUNNING' }), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      workTeamMembership: { findMany: jest.fn().mockResolvedValue([]) },
      asset: {
          findFirst: jest.fn()
            .mockResolvedValueOnce({ id: 'source-1', objectKey: sourceStored.objectKey, mimeType: 'image/png', originalName: 'source.png' })
            .mockResolvedValueOnce({ id: 'source-2', objectKey: sourceStored2.objectKey, mimeType: 'image/png', originalName: 'source-2.png' })
            .mockResolvedValueOnce({ id: 'mask-1', objectKey: maskStored.objectKey, mimeType: 'image/png', originalName: 'mask.png' }),
      },
    };
    const http: any = {
      requestToFile: jest.fn(async (_url: string, _init: unknown, destination: string) => {
        await writeFile(destination, JSON.stringify({ data: [{ b64_json: input.toString('base64') }] }), { flag: 'wx' });
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), filePath: destination, sizeBytes: input.length, url: 'https://api.example.com/v1/images/edits' };
      }),
    };
    const assets = { persistNormalized: jest.fn().mockResolvedValue({}), removeMask: jest.fn().mockResolvedValue(true), removeJobOutputs: jest.fn().mockResolvedValue(0n) };
    const lifecycle = { start: jest.fn().mockResolvedValue(true), finish: jest.fn().mockResolvedValue(true), releaseAndPublish: jest.fn().mockResolvedValue(undefined) };
    const processor = new GenerationProcessor(prisma, { decrypt: jest.fn(() => 'secret') } as any, storage, http, assets as any, lifecycle as any);

    await processor.process({ data: { jobId: 'job-1' }, attemptsMade: 0, opts: { attempts: 3 }, discard: jest.fn() } as any);

    expect(http.requestToFile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirectPolicy: 'same-origin' }), expect.any(String), expect.any(Number), expect.any(Number));
    const requestBody = http.requestToFile.mock.calls[0][1].body as FormData;
    expect(requestBody.has('image[]')).toBe(true);
    expect(requestBody.has('image')).toBe(false);
    expect(requestBody.has('mask')).toBe(true);
    expect(requestBody.getAll('image[]')).toHaveLength(2);
    expect(requestBody.getAll('image[]')[0]).toMatchObject({ name: 'source.png', type: 'image/png' });
    expect(requestBody.getAll('image[]')[1]).toMatchObject({ name: 'source-2.png', type: 'image/png' });
    expect(requestBody.get('mask')).toMatchObject({ name: 'mask.png', type: 'image/png' });
    const serializedRequest = new Request('https://api.example.com/v1/images/edits', { method: 'POST', body: requestBody as any });
    expect(serializedRequest.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    const serializedBody = await serializedRequest.text();
    expect(serializedBody).toContain('name="image[]"');
    expect(serializedBody).toContain('name="mask"');
    expect(lifecycle.finish).toHaveBeenCalledWith('user-1', 'job-1', 'SUCCEEDED');
    expect(assets.removeMask).toHaveBeenCalledWith('user-1', 'mask-1');
  });

  it('marks a non-retryable provider failure once and raises BullMQ UnrecoverableError', async () => {
    const storage = new StorageService();
    const job = {
      id: 'job-4xx', userId: 'user-1', status: 'QUEUED', mode: 'TEXT_TO_IMAGE', user: { status: 'ACTIVE', role: 'USER' },
      model: { upstreamModelId: 'image-model', provider: { baseUrl: 'https://api.example.com/v1', encryptedApiKey: 'encrypted', encryptedHeaders: null, timeoutSeconds: 30 } },
      parameters: { size: '1024x1024', quality: 'auto', count: 1 }, prompt: 'test prompt',
    };
    const prisma: any = {
      generationJob: {
        findUnique: jest.fn().mockResolvedValue(job),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const http: any = {
      requestToFile: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: Buffer.from('{"error":"invalid parameters"}'),
      }),
    };
    const lifecycle = { start: jest.fn().mockResolvedValue(true), finish: jest.fn().mockResolvedValue(true), releaseAndPublish: jest.fn().mockResolvedValue(undefined) };
    const processor = new GenerationProcessor(prisma, { decrypt: jest.fn(() => 'secret') } as any, storage, http, { persistNormalized: jest.fn().mockResolvedValue({}) } as any, lifecycle as any);

    await expect(processor.process({ data: { jobId: job.id }, attemptsMade: 0, opts: { attempts: 3 } } as any)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(http.requestToFile).toHaveBeenCalledTimes(1);
    expect(lifecycle.finish).toHaveBeenCalledWith('user-1', job.id, 'FAILED', expect.objectContaining({ code: 'PROVIDER_PARAMETERS' }));
  });

  it('sends a single edit source as image instead of image[]', async () => {
    const storage = new StorageService();
    const input = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#fff' } }).png().toBuffer();
    const sourceStored = await stageAndSave(storage, 'user-1', input, 'image/png');
    const job = {
      id: 'job-single', userId: 'user-1', status: 'QUEUED', mode: 'IMAGE_EDIT', user: { status: 'ACTIVE', role: 'USER' },
      model: { upstreamModelId: 'image-model', provider: { baseUrl: 'https://api.example.com/v1', encryptedApiKey: 'encrypted', encryptedHeaders: null, timeoutSeconds: 30 } },
      parameters: { sourceAssetIds: ['source-1'], size: '1024x1024', count: 1 }, prompt: 'restyle',
    };
    const prisma: any = {
      generationJob: { findUnique: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({ status: 'RUNNING' }), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      workTeamMembership: { findMany: jest.fn().mockResolvedValue([]) },
      asset: { findFirst: jest.fn().mockResolvedValue({ id: 'source-1', objectKey: sourceStored.objectKey, mimeType: 'image/png', originalName: 'source.png' }) },
    };
    const http: any = {
      requestToFile: jest.fn(async (_url: string, _init: unknown, destination: string) => {
        await writeFile(destination, JSON.stringify({ data: [{ b64_json: input.toString('base64') }] }), { flag: 'wx' });
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), filePath: destination, sizeBytes: input.length, url: 'https://api.example.com/v1/images/edits' };
      }),
    };
    const assets = { persistNormalized: jest.fn().mockResolvedValue({}), removeMask: jest.fn(), removeJobOutputs: jest.fn().mockResolvedValue(0n) };
    const lifecycle = { start: jest.fn().mockResolvedValue(true), finish: jest.fn().mockResolvedValue(true), releaseAndPublish: jest.fn().mockResolvedValue(undefined) };
    const processor = new GenerationProcessor(prisma, { decrypt: jest.fn(() => 'secret') } as any, storage, http, assets as any, lifecycle as any);

    await processor.process({ data: { jobId: 'job-single' }, attemptsMade: 0, opts: { attempts: 3 }, discard: jest.fn() } as any);

    const requestBody = http.requestToFile.mock.calls[0][1].body as FormData;
    expect(requestBody.has('image')).toBe(true);
    expect(requestBody.has('image[]')).toBe(false);
    expect(lifecycle.finish).toHaveBeenCalledWith('user-1', 'job-single', 'SUCCEEDED');
  });

  it('retries image-only chat models through chat completions when Images API rejects the conversation', async () => {
    const storage = new StorageService();
    const input = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#0f0' } }).png().toBuffer();
    const job = {
      id: 'job-chat', userId: 'user-1', status: 'QUEUED', mode: 'TEXT_TO_IMAGE', user: { status: 'ACTIVE', role: 'USER' },
      model: { upstreamModelId: 'gpt-4o-image', provider: { baseUrl: 'https://api.example.com/v1', encryptedApiKey: 'encrypted', encryptedHeaders: null, timeoutSeconds: 30 } },
      parameters: { size: '1024x1024', quality: 'auto', count: 1 }, prompt: 'a green square',
    };
    const prisma: any = {
      generationJob: { findUnique: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({ status: 'RUNNING' }), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    };
    const http: any = {
      requestToFile: jest.fn(async (url: string, _init: unknown, destination: string) => {
        if (url.endsWith('/chat/completions')) {
          await writeFile(destination, `data: {"choices":[{"delta":{"content":"![image](data:image/png;base64,${input.toString('base64')})"}}]}\n\ndata: [DONE]\n`, { flag: 'wx' });
          return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), filePath: destination, sizeBytes: 100, url };
        }
        return {
          ok: false,
          status: 400,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: Buffer.from(JSON.stringify({ error: { code: 'text_conversation_not_supported' } })),
        };
      }),
    };
    const assets = { persistNormalized: jest.fn().mockResolvedValue({}), removeJobOutputs: jest.fn().mockResolvedValue(0n) };
    const lifecycle = { start: jest.fn().mockResolvedValue(true), finish: jest.fn().mockResolvedValue(true), releaseAndPublish: jest.fn().mockResolvedValue(undefined) };
    const processor = new GenerationProcessor(prisma, { decrypt: jest.fn(() => 'secret') } as any, storage, http, assets as any, lifecycle as any);

    await processor.process({ data: { jobId: 'job-chat' }, attemptsMade: 0, opts: { attempts: 3 }, discard: jest.fn() } as any);

    expect(http.requestToFile).toHaveBeenCalledTimes(2);
    expect(http.requestToFile.mock.calls[0][0]).toBe('https://api.example.com/v1/images/generations');
    expect(http.requestToFile.mock.calls[1][0]).toBe('https://api.example.com/v1/chat/completions');
    expect(JSON.parse(http.requestToFile.mock.calls[1][1].body)).toEqual(chatImageCompletionBody('gpt-4o-image', 'a green square'));
    expect(assets.persistNormalized).toHaveBeenCalled();
    expect(lifecycle.finish).toHaveBeenCalledWith('user-1', 'job-chat', 'SUCCEEDED');
  });

  it('persists provider outputs after inspect without re-encoding the original file', async () => {
    const storage = new StorageService();
    const inspect = jest.spyOn(storage, 'inspectImageWithThumbnail');
    const normalize = jest.spyOn(storage, 'normalizeImageFile');
    const input = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#00f' } }).png().toBuffer();
    const job = {
      id: 'job-inspect', userId: 'user-1', status: 'QUEUED', mode: 'TEXT_TO_IMAGE', user: { status: 'ACTIVE', role: 'USER' },
      model: { upstreamModelId: 'image-model', provider: { baseUrl: 'https://api.example.com/v1', encryptedApiKey: 'encrypted', encryptedHeaders: null, timeoutSeconds: 30 } },
      parameters: { size: '1024x1024', quality: 'auto', count: 1 }, prompt: 'a blue square',
    };
    const prisma: any = {
      generationJob: { findUnique: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({ status: 'RUNNING' }), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    };
    const http: any = {
      requestToFile: jest.fn(async (_url: string, _init: unknown, destination: string) => {
        await writeFile(destination, JSON.stringify({ data: [{ b64_json: input.toString('base64') }] }), { flag: 'wx' });
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), filePath: destination, sizeBytes: input.length, url: 'https://api.example.com/v1/images/generations' };
      }),
    };
    const assets = { persistNormalized: jest.fn().mockResolvedValue({}), removeJobOutputs: jest.fn().mockResolvedValue(0n) };
    const lifecycle = { start: jest.fn().mockResolvedValue(true), finish: jest.fn().mockResolvedValue(true), releaseAndPublish: jest.fn().mockResolvedValue(undefined) };
    const processor = new GenerationProcessor(prisma, { decrypt: jest.fn(() => 'secret') } as any, storage, http, assets as any, lifecycle as any);

    try {
      await processor.process({ data: { jobId: 'job-inspect' }, attemptsMade: 0, opts: { attempts: 3 }, discard: jest.fn() } as any);
      expect(inspect).toHaveBeenCalled();
      expect(normalize).not.toHaveBeenCalled();
      expect(assets.persistNormalized).toHaveBeenCalledWith(expect.objectContaining({
        role: 'OUTPUT',
        image: expect.objectContaining({ mimeType: 'image/png', width: 16, height: 16, thumbnail: expect.objectContaining({ mimeType: 'image/webp' }) }),
      }));
    } finally {
      inspect.mockRestore();
      normalize.mockRestore();
    }
  });

  it('sends the composed style prompt to the provider while keeping the stored prompt unchanged', async () => {
    const storage = new StorageService();
    const input = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#00f' } }).png().toBuffer();
    const job = {
      id: 'job-style', userId: 'user-1', status: 'QUEUED', mode: 'TEXT_TO_IMAGE', user: { status: 'ACTIVE', role: 'USER' },
      model: { upstreamModelId: 'gpt-image-1', provider: { baseUrl: 'https://api.example.com/v1', encryptedApiKey: 'encrypted', encryptedHeaders: null, timeoutSeconds: 30 } },
      parameters: { size: '1024x1024', quality: 'high', count: 1, stylePresetId: 'cinematic' }, prompt: '一只橘猫',
    };
    const prisma: any = {
      generationJob: { findUnique: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({ status: 'RUNNING' }), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    };
    const http: any = {
      requestToFile: jest.fn(async (_url: string, _init: unknown, destination: string) => {
        await writeFile(destination, JSON.stringify({ data: [{ b64_json: input.toString('base64') }] }), { flag: 'wx' });
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), filePath: destination, sizeBytes: input.length, url: 'https://api.example.com/v1/images/generations' };
      }),
    };
    const assets = { persistNormalized: jest.fn().mockResolvedValue({}), removeJobOutputs: jest.fn().mockResolvedValue(0n) };
    const lifecycle = { start: jest.fn().mockResolvedValue(true), finish: jest.fn().mockResolvedValue(true), releaseAndPublish: jest.fn().mockResolvedValue(undefined) };
    const processor = new GenerationProcessor(prisma, { decrypt: jest.fn(() => 'secret') } as any, storage, http, assets as any, lifecycle as any);

    await processor.process({ data: { jobId: 'job-style' }, attemptsMade: 0, opts: { attempts: 3 }, discard: jest.fn() } as any);

    const composed = providerPromptFromJob(job);
    expect(composed).toContain('一只橘猫');
    expect(composed).toContain('画面风格：');
    expect(JSON.parse(http.requestToFile.mock.calls[0][1].body)).toEqual(providerImageParameters('gpt-image-1', composed, job.parameters));
  });
});
