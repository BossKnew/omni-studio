import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadFiles, extensionForMime } from './download.ts';

test('uses safe extensions for supported image content types', () => {
  assert.equal(extensionForMime('image/png'), '.png');
  assert.equal(extensionForMime('image/jpeg'), '.jpg');
  assert.equal(extensionForMime('image/webp'), '.webp');
  assert.equal(extensionForMime('application/octet-stream'), '.png');
  assert.equal(extensionForMime('video/mp4'), '.mp4');
});

test('downloads several files with bounded concurrency', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  let inFlight = 0;
  let maxInFlight = 0;
  const clicks: string[] = [];
  globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return {
      ok: false,
      status: 206,
      body: { cancel: async () => undefined },
    };
  }) as unknown as typeof fetch;
  globalThis.document = {
    createElement: (tag: string) => {
      const element = {
        href: '',
        download: '',
        rel: '',
        click() { clicks.push(this.href); },
        remove() {},
      };
      assert.equal(tag, 'a');
      return element;
    },
    body: { appendChild() {} },
  } as unknown as Document;
  try {
    const result = await downloadFiles(
      [1, 2, 3, 4, 5].map((index) => ({ url: `/api/v1/assets/${index}/content`, name: `${index}.png` })),
      undefined,
      60_000,
      2,
    );
    assert.equal(result.completed, 5);
    assert.deepEqual(result.failed, []);
    assert.equal(clicks.length, 5);
    assert.ok(maxInFlight <= 2);
    assert.ok(maxInFlight >= 2);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  }
});

test('probes with a byte range and starts a native download without buffering a blob', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  let blobCalled = false;
  const clicks: string[] = [];
  const headers: Headers[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    headers.push(new Headers(init?.headers));
    return {
      ok: false,
      status: 206,
      body: { cancel: async () => undefined },
      blob: async () => {
        blobCalled = true;
        return new Blob();
      },
    };
  }) as typeof fetch;
  globalThis.document = {
    createElement: (tag: string) => {
      const element = {
        href: '',
        download: '',
        rel: '',
        click() { clicks.push(this.href); },
        remove() {},
      };
      assert.equal(tag, 'a');
      return element;
    },
    body: { appendChild() {} },
  } as unknown as Document;
  try {
    const result = await downloadFiles([{ url: '/api/v1/assets/a/content', name: 'a.png' }]);
    assert.equal(result.completed, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(blobCalled, false);
    assert.equal(headers[0]?.get('Range'), 'bytes=0-0');
    assert.deepEqual(clicks, ['/api/v1/assets/a/content']);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  }
});

test('marks a hung file as failed after the download timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    return await new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
  }) as typeof fetch;
  try {
    const result = await downloadFiles([{ url: 'https://example.test/a.png', name: 'a.png' }], undefined, 20);
    assert.equal(result.completed, 0);
    assert.deepEqual(result.failed, ['a.png']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
