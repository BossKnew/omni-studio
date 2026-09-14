import { serializeGenerationJob } from './generation-response';

describe('serializeGenerationJob', () => {
  it('returns only the public studio response shape', () => {
    const result = serializeGenerationJob({
      id: 'job-1', status: 'FAILED', mode: 'TEXT_TO_IMAGE', prompt: 'hello', errorMessage: 'Generation failed',
      parameters: { count: 2, sourceAssetIds: ['secret-asset'] },
      modelSnapshot: { displayName: 'Friendly model', upstreamModelId: 'secret-model', providerName: 'secret-provider' },
      assets: [{ id: 'asset-1', role: 'OUTPUT', width: 10, height: 20, mimeType: 'image/png', sizeBytes: 42n, note: null, deletedAt: null }],
      userId: 'private-user', modelId: 'private-model-id',
    } as any);

    expect(result).toMatchObject({ id: 'job-1', modelSnapshot: { displayName: 'Friendly model' }, parameters: { count: 2 } });
    expect(JSON.stringify(result)).not.toMatch(/secret-model|secret-provider|secret-asset|private-user|private-model-id/);
  });

  it('exposes a thumbnail URL only when a thumbnail asset exists', () => {
    const base = {
      id: 'job-1', conversationId: 'c1', status: 'SUCCEEDED', mode: 'TEXT_TO_IMAGE', prompt: 'hello', errorMessage: null,
      parameters: { count: 1 }, modelSnapshot: { displayName: 'Model' },
    };
    const withThumb = serializeGenerationJob({
      ...base,
      assets: [{ id: 'asset-1', role: 'OUTPUT', width: 10, height: 20, mimeType: 'image/png', sizeBytes: 42n, note: null, deletedAt: null, thumbnail: { id: 'thumb-1', deletedAt: null } }],
    } as any);
    const withoutThumb = serializeGenerationJob({
      ...base,
      assets: [{ id: 'asset-1', role: 'OUTPUT', width: 10, height: 20, mimeType: 'image/png', sizeBytes: 42n, note: null, deletedAt: null, thumbnail: null }],
    } as any);
    expect(withThumb.assets[0].thumbnailUrl).toBe('/api/v1/assets/thumb-1/content');
    expect(withoutThumb.assets[0].thumbnailUrl).toBeNull();
  });
});
