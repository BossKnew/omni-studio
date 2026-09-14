import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageService, videoInfoFromFfprobe } from './storage.service';

describe('StorageService', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'omnistudio-')); process.env.MEDIA_ROOT = root; });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('validates, saves and reads a private image', async () => {
    const service = new StorageService();
    const buffer = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#fff' } }).png().toBuffer();
    const inputPath = await service.createStagingPath('.png');
    await writeFile(inputPath, buffer, { flag: 'wx' });
    const expectedHash = createHash('sha256').update(buffer).digest('hex');
    await expect(service.hashStaged(inputPath)).resolves.toBe(expectedHash);
    const image = await service.inspectImageFile(inputPath, 'image/png');
    expect(image).toMatchObject({ mimeType: 'image/png', width: 16, height: 16, path: inputPath });
    expect(image.sizeBytes).toBe(BigInt(buffer.length));
    const stored = await service.saveStaged('user-1', inputPath, image.mimeType);
    expect(stored.objectKey.startsWith('user-1/')).toBe(true);
    expect(await readFile(service.filePath(stored.objectKey))).toEqual(buffer);
    await expect(service.hashObject(stored.objectKey)).resolves.toBe(expectedHash);
  });

  it('rejects object keys that escape the media root', async () => {
    const service = new StorageService();
    expect(() => service.filePath('../secret.png')).toThrow('非法对象键');
    expect(() => service.filePath('.staging/secret.png')).toThrow('非法对象键');
    expect(() => service.filePath('.staging-worker/secret.png')).toThrow('非法对象键');
  });

  it('normalizes and atomically promotes a staged image without whole-file buffers', async () => {
    const service = new StorageService();
    const inputPath = await service.createStagingPath('.upload');
    const buffer = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#123456' } }).png().toBuffer();
    await writeFile(inputPath, buffer, { flag: 'wx' });
    const image = await service.normalizeImageFile(inputPath, 'image/png');
    expect(image).toMatchObject({ mimeType: 'image/png', width: 32, height: 24 });
    expect(image.thumbnail).toMatchObject({ mimeType: 'image/webp' });
    expect(await readFile(image.path)).toEqual(buffer);
    const stored = await service.saveStaged('user-1', image.path, image.mimeType);
    expect((await readFile(service.filePath(stored.objectKey))).length).toBe(Number(stored.sizeBytes));
    await service.deleteStaged(inputPath);
    await service.deleteStaged(image.thumbnail!.path);
  });

  it('re-encodes images that have a non-default EXIF orientation', async () => {
    const service = new StorageService();
    const inputPath = await service.createStagingPath('.jpg');
    const buffer = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#123456' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    await writeFile(inputPath, buffer, { flag: 'wx' });
    const image = await service.normalizeImageFile(inputPath, 'image/jpeg');
    expect(image).toMatchObject({ mimeType: 'image/jpeg', width: 16, height: 32 });
    expect(await readFile(image.path)).not.toEqual(buffer);
    await service.deleteStaged(inputPath);
    await service.deleteStaged(image.thumbnail!.path);
  });

  it('inspects an image and writes a thumbnail from the same decode', async () => {
    const service = new StorageService();
    const inputPath = await service.createStagingPath('.png');
    await writeFile(inputPath, await sharp({ create: { width: 64, height: 32, channels: 4, background: '#fff' } }).png().toBuffer(), { flag: 'wx' });
    const prepared = await service.inspectImageWithThumbnail(inputPath, 'image/png');
    expect(prepared).toMatchObject({ mimeType: 'image/png', width: 64, height: 32, path: inputPath });
    expect(prepared.thumbnail).toMatchObject({ mimeType: 'image/webp', width: 64, height: 32 });
    await service.deleteStaged(prepared.thumbnail.path);
  });

  it('rejects staged paths outside the isolated staging directory', async () => {
    const service = new StorageService();
    await expect(service.deleteStaged(join(root, 'user-file.png'))).rejects.toThrow('非法临时文件路径');
  });

  it('creates bounded WebP thumbnails and exact-size provider masks', async () => {
    const service = new StorageService();
    const inputPath = await service.createStagingPath('.png');
    await writeFile(inputPath, await sharp({ create: { width: 1024, height: 512, channels: 4, background: '#fff' } }).png().toBuffer(), { flag: 'wx' });
    const thumbnail = await service.createThumbnailFile(inputPath);
    expect(thumbnail).toMatchObject({ mimeType: 'image/webp', width: 384, height: 192 });

    const stored = await service.saveStaged('user-1', inputPath, 'image/png');
    const resizedMask = await service.resizeMaskFile(stored.objectKey, 800, 400);
    const metadata = await sharp(resizedMask).metadata();
    expect(metadata).toMatchObject({ width: 800, height: 400, format: 'png', hasAlpha: true });
  });

  it('saves a named object key and crops style-preset previews to a square', async () => {
    const service = new StorageService();
    const inputPath = await service.createStagingPath('.png');
    await writeFile(inputPath, await sharp({ create: { width: 640, height: 320, channels: 4, background: '#abc' } }).png().toBuffer(), { flag: 'wx' });
    const preview = await service.createStylePresetPreviewFile(inputPath);
    expect(preview).toMatchObject({ mimeType: 'image/webp', width: 384, height: 384 });
    const stored = await service.saveStagedKey('style-presets/cinematic.webp', preview.path);
    expect(stored.objectKey).toBe('style-presets/cinematic.webp');
    expect(await service.objectSize(stored.objectKey)).toBe(Number(stored.sizeBytes));
    await expect(service.saveStagedKey('../secret.webp', inputPath)).rejects.toThrow('非法对象键');
  });

  it('keeps images within the max long edge without re-encoding', async () => {
    const service = new StorageService();
    const inputPath = await service.createStagingPath('.png');
    const buffer = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#123456' } }).png().toBuffer();
    await writeFile(inputPath, buffer, { flag: 'wx' });
    const image = await service.normalizeImageFile(inputPath, 'image/png', { maxLongEdge: 4096 });
    expect(image).toMatchObject({ mimeType: 'image/png', width: 32, height: 24 });
    expect(await readFile(image.path)).toEqual(buffer);
    await service.deleteStaged(inputPath);
    await service.deleteStaged(image.thumbnail!.path);
  });

  it('downscales uploads whose long edge exceeds the configured cap', async () => {
    const service = new StorageService();
    const inputPath = await service.createStagingPath('.png');
    await writeFile(inputPath, await sharp({ create: { width: 1500, height: 1000, channels: 4, background: '#123456' } }).png().toBuffer(), { flag: 'wx' });
    const image = await service.normalizeImageFile(inputPath, 'image/png', { maxLongEdge: 1024 });
    expect(image.mimeType).toBe('image/png');
    expect(Math.max(image.width, image.height)).toBe(1024);
    expect(image.width).toBeLessThanOrEqual(1024);
    expect(image.height).toBeLessThanOrEqual(1024);
    await service.deleteStaged(inputPath);
    await service.deleteStaged(image.thumbnail!.path);
  });

  it('keeps masks as PNG and uses nearest-neighbor when shrinking', async () => {
    const service = new StorageService();
    const inputPath = await service.createStagingPath('.png');
    await writeFile(inputPath, await sharp({ create: { width: 1500, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(), { flag: 'wx' });
    const image = await service.normalizeImageFile(inputPath, 'image/png', { thumbnail: false, maxLongEdge: 1024, mask: true });
    expect(image).toMatchObject({ mimeType: 'image/png' });
    expect(Math.max(image.width, image.height)).toBe(1024);
    expect(image.thumbnail).toBeUndefined();
    const metadata = await sharp(image.path).metadata();
    expect(metadata).toMatchObject({ format: 'png', hasAlpha: true });
    await service.deleteStaged(inputPath);
  });

  it('still rejects images whose edge exceeds the 8192 hard cap', async () => {
    const service = new StorageService();
    const inputPath = await service.createStagingPath('.png');
    await writeFile(inputPath, await sharp({ create: { width: 8193, height: 8, channels: 4, background: '#fff' } }).png().toBuffer(), { flag: 'wx' });
    await expect(service.normalizeImageFile(inputPath, 'image/png', { maxLongEdge: 4096 })).rejects.toThrow('图片尺寸无效或超过 8192 像素');
    await service.deleteStaged(inputPath);
  });

  it('reads video dimensions from ffprobe JSON', () => {
    expect(videoInfoFromFfprobe({
      streams: [{ codec_type: 'audio' }, { codec_type: 'video', width: 1280, height: 720, duration: '5.0' }],
      format: { duration: '5.04' },
    })).toEqual({ width: 1280, height: 720, durationMs: 5040 });
  });
});
