import { createVideoAdapter, minimaxApiRoot, minimaxResolution, minimaxTaskId, minimaxVideoUrl, openaiVideoSize, openaiVideoTaskId, runwayApiRoot, runwayRatio, runwayTaskId, runwayVideoUrl, seedanceTaskId, seedanceVideoUrl, veoApiRoot, veoOperationName, veoOperationUrl, veoResolution, veoVideoUri, wanApiRoot, wanInput, wanParameters, wanStatus, wanTaskId, wanVideoUrl } from './video-adapters';
import { connectionFailureDetail, isAbortTimeoutError, isProviderConnectionError, mapProviderRequestError, type MediaGenerationRequest, type VideoAdapterDeps } from './provider-adapter';

function request(overrides: Partial<MediaGenerationRequest> = {}): MediaGenerationRequest {
  return {
    mediaKind: 'VIDEO',
    operation: 'TEXT_TO_VIDEO',
    upstreamModelId: 'sora-2',
    prompt: 'a cat on a skateboard',
    parameters: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
    inputAssets: [],
    ...overrides,
  };
}

function httpMock(sequence: Array<{ ok?: boolean; status?: number; json?: unknown; headers?: Record<string, string>; body?: Buffer }>) {
  const calls: Array<{ url: string; init: any }> = [];
  return {
    calls,
    http: {
      request: jest.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        const next = sequence.shift() ?? { ok: true, status: 200, json: {} };
        const body = next.body ?? Buffer.from(JSON.stringify(next.json ?? {}));
        return {
          ok: next.ok ?? true,
          status: next.status ?? 200,
          headers: new Headers({ 'content-type': next.headers?.['content-type'] ?? 'application/json', ...next.headers }),
          body,
          url,
        };
      }),
      requestToFile: jest.fn(),
    },
  };
}

function deps(http: any, overrides: Partial<VideoAdapterDeps> = {}): VideoAdapterDeps {
  return {
    http,
    headers: { Authorization: 'Bearer secret' },
    baseUrl: 'https://api.example.com/v1',
    timeoutSeconds: 30,
    pollTimeoutSeconds: 60,
    sleep: jest.fn().mockResolvedValue(undefined),
    now: () => 0,
    ...overrides,
  };
}

describe('video adapter payload parsers', () => {
  it('reads OpenAI, Seedance and Wan identifiers from documented envelopes', () => {
    expect(openaiVideoTaskId({ id: 'video_123' })).toBe('video_123');
    expect(seedanceTaskId({ id: 'cgt-1' })).toBe('cgt-1');
    expect(seedanceVideoUrl({ content: { video_url: 'https://cdn.example/v.mp4' } })).toBe('https://cdn.example/v.mp4');
    expect(wanTaskId({ output: { task_id: 'task-9' } })).toBe('task-9');
    expect(wanStatus({ output: { task_status: 'SUCCEEDED' } })).toBe('SUCCEEDED');
    expect(wanVideoUrl({ output: { video_url: 'https://cdn.example/w.mp4' } })).toBe('https://cdn.example/w.mp4');
    expect(veoOperationName({ name: 'operations/abc' })).toBe('operations/abc');
    expect(veoVideoUri({ response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/1:download' } }] } } })).toBe('https://generativelanguage.googleapis.com/v1beta/files/1:download');
    expect(minimaxTaskId({ task_id: '424010985738629' })).toBe('424010985738629');
    expect(minimaxVideoUrl({ task: { status: 'succeeded', content: { url: 'https://cdn.example/h3.mp4' } } })).toBe('https://cdn.example/h3.mp4');
  });
});

describe('openai-videos adapter', () => {
  it('creates a JSON text-to-video job and downloads content after polling', async () => {
    const { http, calls } = httpMock([
      { json: { id: 'video_1', status: 'queued' } },
      { json: { id: 'video_1', status: 'in_progress' } },
      { json: { id: 'video_1', status: 'completed' } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('openai-videos', deps(http));
    await expect(adapter.createTask(request())).resolves.toBe('video_1');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ model: 'sora-2', prompt: 'a cat on a skateboard', seconds: '5', size: '1280x720' });
    expect(JSON.parse(calls[0].init.body)).not.toHaveProperty('quality');
    expect(openaiVideoSize('16:9')).toBe('1280x720');
    expect(openaiVideoSize('9:16', '1080p')).toBe('1024x1792');
    expect(openaiVideoSize('1280x720')).toBe('1280x720');

    const media = await adapter.collect('video_1', request());
    expect(media[0]).toMatchObject({ mimeType: 'video/mp4' });
    expect(calls[3].url).toBe('https://api.example.com/v1/videos/video_1/content');
    expect(calls[3].init.headers.Authorization).toBe('Bearer secret');
    expect(calls[3].init.redirectPolicy).toBe('same-origin');
  });

  it('does not recreate a task when collect is resumed', async () => {
    const { http, calls } = httpMock([
      { json: { id: 'video_1', status: 'completed' } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('openai-videos', deps(http));
    await adapter.collect('video_1', request());
    expect(calls.every((call) => !call.url.endsWith('/videos') || call.init.method !== 'POST')).toBe(true);
  });
});

describe('seedance adapter', () => {
  it('maps ratio, duration and first-frame data URLs', async () => {
    const { http, calls } = httpMock([
      { json: { id: 'cgt-9' } },
      { json: { status: 'succeeded', content: { video_url: 'https://cdn.example/out.mp4' } } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('seedance', deps(http, { baseUrl: 'https://ark.example/api/v3' }));
    const png = { mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]), role: 'SOURCE' as const };
    await expect(adapter.createTask(request({ operation: 'IMAGE_TO_VIDEO', inputAssets: [png] }))).resolves.toBe('cgt-9');
    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({ model: 'sora-2', duration: 5, ratio: '16:9', resolution: '720p', watermark: false });
    expect(body.content[1].image_url.url).toMatch(/^data:image\/png;base64,/);

    const media = await adapter.collect('cgt-9', request());
    expect(media[0].mimeType).toBe('video/mp4');
    expect(calls[2].init.headers).toBeUndefined();
    expect(calls[2].init.redirectPolicy).toBe('any');
  });
});

describe('wan adapter', () => {
  it('normalizes Wan 2.7 base URLs and ratio/resolution parameters', () => {
    expect(wanApiRoot('https://dashscope.aliyuncs.com')).toBe('https://dashscope.aliyuncs.com/api/v1');
    expect(wanApiRoot('https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis')).toBe('https://dashscope.aliyuncs.com/api/v1');
    expect(wanApiRoot('https://abc.cn-beijing.maas.aliyuncs.com')).toBe('https://abc.cn-beijing.maas.aliyuncs.com/api/v1');
    expect(wanApiRoot('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('https://dashscope.aliyuncs.com/api/v1');
    expect(wanParameters({ aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' })).toMatchObject({ duration: 5, ratio: '16:9', resolution: '720P' });
    const first = { mimeType: 'image/png', bytes: new Uint8Array([1]), role: 'SOURCE' as const };
    const last = { mimeType: 'image/png', bytes: new Uint8Array([2]), role: 'SOURCE' as const };
    expect(wanInput(request({ upstreamModelId: 'wan2.7-i2v', inputAssets: [first, last] })).media).toEqual([
      { type: 'first_frame', url: expect.stringMatching(/^data:image\/png;base64,/) },
      { type: 'last_frame', url: expect.stringMatching(/^data:image\/png;base64,/) },
    ]);
  });

  it('sends DashScope async header and polls task_status', async () => {
    const { http, calls } = httpMock([
      { json: { output: { task_id: 'task-1', task_status: 'PENDING' } } },
      { json: { output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example/wan.mp4' } } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('wan', deps(http, { baseUrl: 'https://dashscope.example/api/v1' }));
    await expect(adapter.createTask(request({ upstreamModelId: 'wan2.7-t2v' }))).resolves.toBe('task-1');
    expect(calls[0].init.headers['X-DashScope-Async']).toBe('enable');
    expect(calls[0].url).toBe('https://dashscope.example/api/v1/services/aigc/video-generation/video-synthesis');
    expect(JSON.parse(calls[0].init.body).parameters).toMatchObject({ duration: 5, ratio: '16:9', resolution: '720P' });
    await adapter.collect('task-1', request());
    expect(calls[1].url).toBe('https://dashscope.example/api/v1/tasks/task-1');
  });

  it('surfaces DashScope error payloads that still use HTTP 200', async () => {
    const { http } = httpMock([{ json: { code: 'InvalidParameter', message: 'url error, please check url!' } }]);
    const adapter = createVideoAdapter('wan', deps(http, { baseUrl: 'https://dashscope.aliyuncs.com/api/v1' }));
    await expect(adapter.createTask(request({ upstreamModelId: 'wan2.7-t2v' }))).rejects.toMatchObject({
      providerFailure: { message: expect.stringContaining('url error, please check url!') },
    });
  });

  it('treats 401 on the probe task as an auth failure', async () => {
    const { http } = httpMock([{ ok: false, status: 401, json: { error: 'unauthorized' } }]);
    const adapter = createVideoAdapter('wan', deps(http, { baseUrl: 'https://dashscope.example/api/v1' }));
    await expect(adapter.testConnection()).resolves.toMatchObject({ ok: false, status: 401 });
  });
});

describe('veo adapter', () => {
  it('normalizes Gemini base URLs, operation paths and resolution labels', () => {
    expect(veoApiRoot('https://generativelanguage.googleapis.com')).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(veoApiRoot('https://generativelanguage.googleapis.com/v1beta')).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(veoOperationUrl('https://generativelanguage.googleapis.com/v1beta', 'operations/abc')).toBe('https://generativelanguage.googleapis.com/v1beta/operations/abc');
    expect(veoOperationUrl('https://generativelanguage.googleapis.com/v1beta', 'abc')).toBe('https://generativelanguage.googleapis.com/v1beta/operations/abc');
    expect(veoResolution('720P')).toBe('720p');
    expect(veoResolution('4K')).toBe('4k');
  });

  it('creates a predictLongRunning job with Gemini headers and polls the operation', async () => {
    const { http, calls } = httpMock([
      { json: { name: 'operations/op-1' } },
      { json: { name: 'operations/op-1', done: false } },
      { json: { name: 'operations/op-1', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/vid:download' } }] } } } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('veo', deps(http, { baseUrl: 'https://generativelanguage.googleapis.com' }));
    await expect(adapter.createTask(request({ upstreamModelId: 'veo-3.1-generate-preview' }))).resolves.toBe('operations/op-1');
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
    expect(calls[0].init.headers['x-goog-api-key']).toBe('secret');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      instances: [{ prompt: 'a cat on a skateboard' }],
      parameters: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
    });

    const media = await adapter.collect('operations/op-1', request());
    expect(media[0].mimeType).toBe('video/mp4');
    expect(calls[2].url).toBe('https://generativelanguage.googleapis.com/v1beta/operations/op-1');
    expect(calls[3].init.headers['x-goog-api-key']).toBe('secret');
    expect(calls[3].init.redirectPolicy).toBe('any');
  });

  it('sends the first reference image as the starting frame', async () => {
    const { http, calls } = httpMock([{ json: { name: 'operations/op-2' } }]);
    const adapter = createVideoAdapter('veo', deps(http, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }));
    const png = { mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]), role: 'SOURCE' as const };
    await adapter.createTask(request({ operation: 'IMAGE_TO_VIDEO', upstreamModelId: 'veo-3.1-generate-preview', inputAssets: [png] }));
    const body = JSON.parse(calls[0].init.body);
    expect(body.instances[0].image).toEqual({ bytesBase64Encoded: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' });
  });

  it('surfaces a completed operation error', async () => {
    const { http } = httpMock([{ json: { name: 'operations/op-3', done: true, error: { code: 3, message: 'prompt was blocked' } } }]);
    const adapter = createVideoAdapter('veo', deps(http, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }));
    await expect(adapter.collect('operations/op-3', request())).rejects.toMatchObject({
      noRetry: true,
      providerFailure: { message: expect.stringContaining('prompt was blocked') },
    });
  });

  it('treats 401 on the models list as an auth failure', async () => {
    const { http } = httpMock([{ ok: false, status: 401, json: { error: { message: 'API key not valid' } } }]);
    const adapter = createVideoAdapter('veo', deps(http, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }));
    await expect(adapter.testConnection()).resolves.toMatchObject({ ok: false, status: 401 });
  });
});

describe('minimax adapter', () => {
  it('normalizes MiniMax base URLs and resolution labels', () => {
    expect(minimaxApiRoot('https://api.minimaxi.com')).toBe('https://api.minimaxi.com');
    expect(minimaxApiRoot('https://api.minimaxi.com/v1')).toBe('https://api.minimaxi.com');
    expect(minimaxApiRoot('https://api.minimax.io/v2/')).toBe('https://api.minimax.io');
    expect(minimaxResolution('2k')).toBe('2K');
    expect(minimaxResolution('768p')).toBe('768P');
  });

  it('creates a v2 content task and polls until the download URL is ready', async () => {
    const { http, calls } = httpMock([
      { json: { task_id: '424010985738629' } },
      { json: { task: { id: '424010985738629', status: 'running' } } },
      { json: { task: { id: '424010985738629', status: 'succeeded', content: { url: 'https://cdn.example/h3.mp4' } } } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('minimax', deps(http, { baseUrl: 'https://api.minimaxi.com' }));
    await expect(adapter.createTask(request({ upstreamModelId: 'MiniMax-H3' }))).resolves.toBe('424010985738629');
    expect(calls[0].url).toBe('https://api.minimaxi.com/v2/video_generation');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      model: 'MiniMax-H3',
      duration: 5,
      resolution: '720p',
      ratio: '16:9',
      content: [{ type: 'text', text: 'a cat on a skateboard' }],
    });

    const media = await adapter.collect('424010985738629', request());
    expect(media[0].mimeType).toBe('video/mp4');
    expect(calls[2].url).toBe('https://api.minimaxi.com/v2/query/video_generation/424010985738629');
    expect(calls[3].init.redirectPolicy).toBe('any');
  });

  it('sends the first reference image as first_frame and omits ratio', async () => {
    const { http, calls } = httpMock([{ json: { task_id: 'img-1' } }]);
    const adapter = createVideoAdapter('minimax', deps(http, { baseUrl: 'https://api.minimax.io' }));
    const png = { mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]), role: 'SOURCE' as const };
    await adapter.createTask(request({ operation: 'IMAGE_TO_VIDEO', upstreamModelId: 'MiniMax-H3', inputAssets: [png] }));
    const body = JSON.parse(calls[0].init.body);
    expect(body.ratio).toBeUndefined();
    expect(body.content[1]).toMatchObject({ type: 'image_url', role: 'first_frame' });
    expect(body.content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('surfaces MiniMax base_resp errors on HTTP 200', async () => {
    const { http } = httpMock([{ json: { base_resp: { status_code: 1004, status_msg: 'login fail' } } }]);
    const adapter = createVideoAdapter('minimax', deps(http, { baseUrl: 'https://api.minimaxi.com' }));
    await expect(adapter.createTask(request({ upstreamModelId: 'MiniMax-H3' }))).rejects.toMatchObject({
      providerFailure: { message: expect.stringContaining('login fail') },
    });
  });

  it('treats 401 on the task list as an auth failure', async () => {
    const { http } = httpMock([{ ok: false, status: 401, json: { error: 'unauthorized' } }]);
    const adapter = createVideoAdapter('minimax', deps(http, { baseUrl: 'https://api.minimaxi.com' }));
    await expect(adapter.testConnection()).resolves.toMatchObject({ ok: false, status: 401 });
  });
});

describe('runway adapter', () => {
  it('normalizes Runway base URLs and maps common ratios to pixel sizes', () => {
    expect(runwayApiRoot('https://api.dev.runwayml.com')).toBe('https://api.dev.runwayml.com');
    expect(runwayApiRoot('https://api.dev.runwayml.com/v1')).toBe('https://api.dev.runwayml.com');
    expect(runwayRatio('16:9')).toBe('1280:720');
    expect(runwayRatio('1280x768')).toBe('1280:768');
    expect(runwayTaskId({ id: '497f6eca-6276-4993-bfeb-53cbbbba6f08' })).toBe('497f6eca-6276-4993-bfeb-53cbbbba6f08');
    expect(runwayVideoUrl({ output: ['https://cdn.example/out.mp4'] })).toBe('https://cdn.example/out.mp4');
  });

  it('creates a text-to-video job with X-Runway-Version and polls the task', async () => {
    const { http, calls } = httpMock([
      { json: { id: 'task-1' } },
      { json: { id: 'task-1', status: 'RUNNING' } },
      { json: { id: 'task-1', status: 'SUCCEEDED', output: ['https://cdn.example/runway.mp4'] } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('runway', deps(http, { baseUrl: 'https://api.dev.runwayml.com' }));
    await expect(adapter.createTask(request({ upstreamModelId: 'gen4.5' }))).resolves.toBe('task-1');
    expect(calls[0].url).toBe('https://api.dev.runwayml.com/v1/text_to_video');
    expect(calls[0].init.headers['X-Runway-Version']).toBe('2024-11-06');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      model: 'gen4.5',
      promptText: 'a cat on a skateboard',
      ratio: '1280:720',
      duration: 5,
    });

    const media = await adapter.collect('task-1', request());
    expect(media[0].mimeType).toBe('video/mp4');
    expect(calls[2].url).toBe('https://api.dev.runwayml.com/v1/tasks/task-1');
  });

  it('sends promptImage on image-to-video and supports first/last frames', async () => {
    const { http, calls } = httpMock([{ json: { id: 'task-2' } }]);
    const adapter = createVideoAdapter('runway', deps(http, { baseUrl: 'https://api.dev.runwayml.com' }));
    const first = { mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]), role: 'SOURCE' as const };
    const last = { mimeType: 'image/png', bytes: new Uint8Array([4, 5, 6]), role: 'SOURCE' as const };
    await adapter.createTask(request({ operation: 'IMAGE_TO_VIDEO', upstreamModelId: 'gen4.5', inputAssets: [first, last] }));
    expect(calls[0].url).toBe('https://api.dev.runwayml.com/v1/image_to_video');
    const body = JSON.parse(calls[0].init.body);
    expect(body.promptImage).toEqual([
      { uri: expect.stringMatching(/^data:image\/png;base64,/), position: 'first' },
      { uri: expect.stringMatching(/^data:image\/png;base64,/), position: 'last' },
    ]);
  });

  it('treats 401 on the dummy task as an auth failure', async () => {
    const { http } = httpMock([{ ok: false, status: 401, json: { error: 'unauthorized' } }]);
    const adapter = createVideoAdapter('runway', deps(http, { baseUrl: 'https://api.dev.runwayml.com' }));
    await expect(adapter.testConnection()).resolves.toMatchObject({ ok: false, status: 401 });
  });
});

describe('flux-video adapter', () => {
  it('creates a t2v job and polls the returned polling_url', async () => {
    const { http, calls } = httpMock([
      { json: { id: 'vid-1', polling_url: 'https://api.eu.bfl.ai/v1/get_result?id=vid-1' } },
      { json: { status: 'Pending' } },
      { json: { status: 'Ready', result: { sample: 'https://delivery.bfl.ai/out.mp4' } } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('flux-video', deps(http, { baseUrl: 'https://api.bfl.ai' }));
    await expect(adapter.createTask(request({ upstreamModelId: 'flux-3-video' }))).resolves.toBe('vid-1|https://api.eu.bfl.ai/v1/get_result?id=vid-1');
    expect(calls[0].url).toBe('https://api.bfl.ai/v1/flux-3-video');
    expect(calls[0].init.headers['x-key']).toBe('secret');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      mode: 't2v',
      prompt: 'a cat on a skateboard',
      aspect_ratio: '16:9',
      duration: 5,
      resolution: 'hd',
    });

    const media = await adapter.collect('vid-1|https://api.eu.bfl.ai/v1/get_result?id=vid-1', request());
    expect(media[0].mimeType).toBe('video/mp4');
    expect(calls[2].url).toBe('https://api.eu.bfl.ai/v1/get_result?id=vid-1');
  });

  it('sends i2v keyframes from reference images', async () => {
    const { http, calls } = httpMock([
      { json: { id: 'vid-2', polling_url: 'https://api.bfl.ai/v1/get_result?id=vid-2' } },
      { json: { id: 'vid-3', polling_url: 'https://api.bfl.ai/v1/get_result?id=vid-3' } },
    ]);
    const adapter = createVideoAdapter('flux-video', deps(http, { baseUrl: 'https://api.bfl.ai' }));
    const png = { mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]), role: 'SOURCE' as const };
    await adapter.createTask(request({ operation: 'IMAGE_TO_VIDEO', upstreamModelId: 'flux-3-video', inputAssets: [png] }));
    const body = JSON.parse(calls[0].init.body);
    expect(body.mode).toBe('i2v');
    expect(body.keyframes).toMatch(/^data:image\/png;base64,/);
    const second = { mimeType: 'image/png', bytes: new Uint8Array([4, 5, 6]), role: 'SOURCE' as const };
    await adapter.createTask(request({ operation: 'IMAGE_TO_VIDEO', upstreamModelId: 'flux-3-video', inputAssets: [png, second] }));
    expect(JSON.parse(calls[1].init.body).keyframes).toHaveLength(2);
  });

  it('treats 401 on get_result as an auth failure', async () => {
    const { http } = httpMock([{ ok: false, status: 401, json: { detail: 'invalid key' } }]);
    const adapter = createVideoAdapter('flux-video', deps(http, { baseUrl: 'https://api.bfl.ai' }));
    await expect(adapter.testConnection()).resolves.toMatchObject({ ok: false, status: 401 });
  });
});

describe('video adapter timeouts', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the longer of generation and poll timeouts for create and download', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    const { http, calls } = httpMock([
      { json: { id: 'video_1' } },
      { json: { id: 'video_1', status: 'completed' } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('openai-videos', deps(http, { timeoutSeconds: 900, pollTimeoutSeconds: 1800 }));
    await adapter.createTask(request());
    await adapter.collect('video_1', request());
    expect(timeoutSpy.mock.calls.map((call) => call[0])).toEqual([1_800_000, 900_000, 1_800_000]);
    expect(calls[0].init.timeoutMs).toBe(1_800_000);
    expect(calls[1].init.timeoutMs).toBe(900_000);
    expect(calls[2].init.timeoutMs).toBe(1_800_000);
  });

  it('keeps a 120s floor for video downloads when generation timeout is lower', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    const { http } = httpMock([
      { json: { id: 'video_1', status: 'completed' } },
      { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('mp4data') },
    ]);
    const adapter = createVideoAdapter('openai-videos', deps(http, { timeoutSeconds: 30 }));
    await adapter.collect('video_1', request());
    expect(timeoutSpy.mock.calls.map((call) => call[0])).toEqual([30_000, 120_000]);
  });

  it('fails collect after pollTimeoutSeconds elapses', async () => {
    let now = 0;
    const { http } = httpMock([
      { json: { id: 'video_1', status: 'in_progress' } },
      { json: { id: 'video_1', status: 'in_progress' } },
    ]);
    const adapter = createVideoAdapter('openai-videos', deps(http, {
      pollTimeoutSeconds: 60,
      now: () => now,
      sleep: async () => { now = 60_000; },
    }));
    await expect(adapter.collect('video_1', request())).rejects.toMatchObject({
      noRetry: true,
      providerFailure: { code: 'PROVIDER_TIMEOUT', message: expect.stringContaining('任务等待超时') },
    });
  });

  it('maps AbortSignal timeout errors to a provider timeout failure', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(isAbortTimeoutError(timeout)).toBe(true);
    expect(isAbortTimeoutError(new Error('socket hang up'))).toBe(false);
    expect(mapProviderRequestError(timeout)).toMatchObject({
      noRetry: true,
      providerFailure: { code: 'PROVIDER_TIMEOUT', message: expect.stringContaining('提高生成超时') },
    });
  });

  it('does not treat a 10s TCP connect timeout as a generation timeout', () => {
    const connect = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    const wrapped = new Error('fetch failed', { cause: connect });
    expect(isAbortTimeoutError(connect)).toBe(false);
    expect(isProviderConnectionError(wrapped)).toBe(true);
    expect(mapProviderRequestError(wrapped)).toMatchObject({
      providerFailure: { code: 'PROVIDER_CONNECTION', message: expect.stringContaining('连接超时') },
    });
  });

  it('labels a TLS handshake reset separately from a generation timeout', () => {
    const reset = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });
    expect(connectionFailureDetail(reset)).toBe('TLS 握手被重置');
    expect(mapProviderRequestError(new Error('fetch failed', { cause: reset }))).toMatchObject({
      providerFailure: { code: 'PROVIDER_CONNECTION', message: expect.stringContaining('TLS 握手被重置') },
    });
  });
});
