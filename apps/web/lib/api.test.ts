import assert from 'node:assert/strict';
import test from 'node:test';
import { apiCacheMode } from './api-cache.ts';

test('allows the browser HTTP cache for read-mostly catalogs', () => {
  assert.equal(apiCacheMode('/models'), 'default');
  assert.equal(apiCacheMode('/option-labels'), 'default');
  assert.equal(apiCacheMode('/style-presets'), 'default');
});

test('keeps mutating and user-state requests uncached', () => {
  assert.equal(apiCacheMode('/conversations'), 'no-store');
  assert.equal(apiCacheMode('/usage'), 'no-store');
  assert.equal(apiCacheMode('/models', { method: 'POST' }), 'no-store');
});
