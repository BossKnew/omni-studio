const CATALOG_GETS = new Set(['/models', '/option-labels', '/style-presets']);

export function apiCacheMode(path: string, init?: RequestInit): RequestCache {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return 'no-store';
  return CATALOG_GETS.has(path.split('?')[0] ?? '') ? 'default' : 'no-store';
}
