import { applyPrivateCatalogCache, catalogEtag, noStoreByDefault } from './cache-policy';

describe('noStoreByDefault', () => {
  it('marks API responses no-store before a controller can opt into private caching', () => {
    const response = { setHeader: jest.fn() };
    const next = jest.fn();
    noStoreByDefault({} as any, response as any, next);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('private catalog cache', () => {
  it('sets a short private cache and returns 304 on matching ETag', () => {
    const etag = catalogEtag({ id: 'model-1' });
    const response = { setHeader: jest.fn(), status: jest.fn() };
    expect(applyPrivateCatalogCache({ headers: { 'if-none-match': etag } } as any, response as any, etag)).toBe(true);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=30');
    expect(response.setHeader).toHaveBeenCalledWith('ETag', etag);
    expect(response.status).toHaveBeenCalledWith(304);
  });

  it('skips caching when no response object is available', () => {
    expect(applyPrivateCatalogCache(undefined, undefined, '"abc"')).toBe(false);
  });
});
