import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ifNoneMatchHits } from './asset-response';

export const CATALOG_CACHE_SECONDS = 30;

export function noStoreByDefault(_request: Request, response: Response, next: NextFunction) {
  response.setHeader('Cache-Control', 'no-store');
  next();
}

export function catalogEtag(...parts: unknown[]) {
  return `"${createHash('sha1').update(JSON.stringify(parts)).digest('base64url').slice(0, 20)}"`;
}

export function applyPrivateCatalogCache(request: Request | undefined, response: Response | undefined, etag: string) {
  if (!response) return false;
  response.setHeader('Cache-Control', `private, max-age=${CATALOG_CACHE_SECONDS}`);
  response.setHeader('ETag', etag);
  response.setHeader('Vary', 'Cookie');
  if (ifNoneMatchHits(request?.headers?.['if-none-match'], etag)) {
    response.status(304);
    return true;
  }
  return false;
}
