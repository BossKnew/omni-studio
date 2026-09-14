import { assetContentUrl, ifNoneMatchHits, mediaCacheControl, mediaEtag, serializeAssetLinks } from './asset-response';

describe('asset content cache helpers', () => {
  it('adds a short content-hash query only when a hash is present', () => {
    expect(assetContentUrl('asset-1')).toBe('/api/v1/assets/asset-1/content');
    expect(assetContentUrl('asset-1', '0123456789abcdefrest')).toBe('/api/v1/assets/asset-1/content?v=0123456789abcdef');
  });

  it('uses immutable caching when the bytes are fingerprinted', () => {
    expect(mediaCacheControl(null)).toBe('private, max-age=3600');
    expect(mediaCacheControl('abc')).toBe('private, max-age=31536000, immutable');
    expect(mediaEtag({ id: 'asset-1', sizeBytes: 9n, contentHash: 'deadbeef' })).toBe('"deadbeef"');
    expect(mediaEtag({ id: 'asset-1', sizeBytes: 9n })).toBe('"asset-1-9"');
    expect(ifNoneMatchHits('"deadbeef"', '"deadbeef"')).toBe(true);
    expect(ifNoneMatchHits('W/"deadbeef", "other"', '"deadbeef"')).toBe(true);
    expect(ifNoneMatchHits('"other"', '"deadbeef"')).toBe(false);
  });

  it('exposes thumbnail dimensions and cache-busting URLs', () => {
    expect(serializeAssetLinks({
      id: 'asset-1',
      contentHash: '0123456789abcdefrest',
      thumbnail: { id: 'thumb-1', deletedAt: null, contentHash: 'fff0000000000001', width: 384, height: 192 },
    })).toEqual({
      deleted: false,
      contentUrl: '/api/v1/assets/asset-1/content?v=0123456789abcdef',
      thumbnailUrl: '/api/v1/assets/thumb-1/content?v=fff0000000000001',
      thumbnailWidth: 384,
      thumbnailHeight: 192,
    });
  });
});
