export type DownloadItem = { url: string; name: string };

export type DownloadResult = {
  completed: number;
  failed: string[];
};

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_CONCURRENCY = 4;

export async function downloadFiles(
  items: DownloadItem[],
  onProgress?: (completed: number, total: number) => void,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  concurrency = DEFAULT_DOWNLOAD_CONCURRENCY,
): Promise<DownloadResult> {
  const failed: string[] = [];
  let completed = 0;
  onProgress?.(0, items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(items.length, 1)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      try {
        const response = await fetch(item.url, {
          credentials: 'include',
          headers: { Range: 'bytes=0-0' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
        if (response.body) await response.body.cancel().catch(() => undefined);
        const anchor = document.createElement('a');
        anchor.href = item.url;
        anchor.download = item.name;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        completed += 1;
      } catch {
        failed.push(item.name);
      }
      onProgress?.(completed, items.length);
    }
  });
  if (items.length) await Promise.all(workers);
  return { completed, failed };
}

export function extensionForMime(mimeType?: string) {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'video/mp4') return '.mp4';
  return '.png';
}
