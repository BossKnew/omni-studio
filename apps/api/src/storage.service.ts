import { Injectable, OnModuleInit } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { ConcurrencyGate } from './concurrency-gate';
import { mediaStagingDirName } from './process-role';
import { securityConfig } from './security-config';
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_VIDEO_BYTES, THUMBNAIL_MAX_EDGE, THUMBNAIL_QUALITY } from './domain-constants';

const execFileAsync = promisify(execFile);

const MAX_IMAGE_PIXELS = MAX_IMAGE_EDGE * MAX_IMAGE_EDGE;
const DOWNSIZE_QUALITY = 82;
const COMPACT_QUALITY = 70;

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
};

sharp.cache(false);
sharp.concurrency(1);

@Injectable()
export class StorageService implements OnModuleInit {
  readonly root = resolve(process.env.MEDIA_ROOT ?? resolve(process.cwd(), 'media'));
  readonly stagingRoot = resolve(this.root, mediaStagingDirName());
  private readonly imageProcessing = new ConcurrencyGate(securityConfig.imageProcessingConcurrency());

  async onModuleInit() {
    await rm(this.stagingRoot, { recursive: true, force: true });
    await mkdir(this.stagingRoot, { recursive: true });
  }

  async createStagingPath(extension = '.tmp') {
    await mkdir(this.stagingRoot, { recursive: true });
    const safeExtension = /^\.[a-z0-9]{1,12}$/i.test(extension) ? extension : '.tmp';
    return resolve(this.stagingRoot, `${randomUUID()}${safeExtension}`);
  }

  async inspectImageFile(path: string, claimedMime?: string) {
    this.assertStagingPath(path);
    return this.imageProcessing.run(() => this.inspectImageFileUnlocked(path, claimedMime));
  }

  async inspectImageWithThumbnail(path: string, claimedMime?: string) {
    this.assertStagingPath(path);
    return this.imageProcessing.run(async () => {
      const pipeline = this.sharpImage(path);
      const inspected = await this.inspectSharp(pipeline, claimedMime);
      const file = await stat(path);
      if (file.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 20 MiB');
      const thumbnail = await this.writeThumbnailFrom(pipeline);
      return { path, sizeBytes: BigInt(file.size), mimeType: inspected.mimeType, width: inspected.width, height: inspected.height, thumbnail };
    });
  }

  async normalizeImageFile(inputPath: string, claimedMime?: string, options?: { thumbnail?: boolean; maxLongEdge?: number; mask?: boolean }) {
    this.assertStagingPath(inputPath);
    return this.imageProcessing.run(async () => {
      const pipeline = this.sharpImage(inputPath);
      const inspected = await this.inspectSharp(pipeline, claimedMime);
      const file = await stat(inputPath);
      if (file.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 20 MiB');
      const maxLongEdge = resizeLongEdge(options?.maxLongEdge);
      const needsDownscale = maxLongEdge != null && Math.max(inspected.width, inspected.height) > maxLongEdge;
      const outputPath = await this.createStagingPath(MIME_EXT[inspected.mimeType]);
      let thumbnail: Awaited<ReturnType<StorageService['writeThumbnailFrom']>> | undefined;
      try {
        if (options?.thumbnail !== false) thumbnail = await this.writeThumbnailFrom(pipeline);
        if (!needsReencode(inspected.orientation) && !needsDownscale) {
          await copyFile(inputPath, outputPath);
          return {
            path: outputPath,
            sizeBytes: BigInt(file.size),
            mimeType: inspected.mimeType,
            width: inspected.width,
            height: inspected.height,
            thumbnail,
          };
        }
        const encode = (image: ReturnType<typeof sharp>, quality: 'normal' | 'compact') => encodeNormalized(image, inspected.mimeType, {
          maxLongEdge: needsDownscale ? maxLongEdge : undefined,
          mask: options?.mask,
          quality,
        });
        let info = await encode(pipeline, 'normal').toFile(outputPath);
        let written = await stat(outputPath);
        if (written.size > MAX_IMAGE_BYTES) {
          info = await encode(this.sharpImage(inputPath), 'compact').toFile(outputPath);
          written = await stat(outputPath);
        }
        if (written.size > MAX_IMAGE_BYTES) throw new Error('规范化后的图片不能超过 20 MiB');
        return {
          path: outputPath,
          sizeBytes: BigInt(written.size),
          mimeType: inspected.mimeType,
          width: info.width,
          height: info.height,
          thumbnail,
        };
      } catch (error) {
        await Promise.all([
          this.deleteStaged(outputPath).catch(() => undefined),
          thumbnail ? this.deleteStaged(thumbnail.path).catch(() => undefined) : Promise.resolve(),
        ]);
        throw error;
      }
    });
  }

  async createThumbnailFile(inputPath: string) {
    this.assertStagingPath(inputPath);
    return this.imageProcessing.run(() => this.createThumbnailUnlocked(inputPath));
  }

  async createThumbnailFromObject(objectKey: string) {
    return this.imageProcessing.run(() => this.createThumbnailUnlocked(this.resolveKey(objectKey)));
  }

  async inspectVideoFile(path: string) {
    this.assertStagingPath(path);
    const file = await stat(path);
    if (file.size > MAX_VIDEO_BYTES) throw new Error('视频不能超过 256 MiB');
    if (file.size < 32) throw new Error('供应商返回了空的视频文件');
    const mp4 = await isMp4File(path);
    let width: number | null = null;
    let height: number | null = null;
    let durationMs: number | null = null;
    try {
      const info = videoInfoFromFfprobe(await probeVideo(path));
      width = info.width;
      height = info.height;
      durationMs = info.durationMs;
    } catch {
      if (!mp4) throw new Error('供应商返回的文件不是有效 MP4 视频，或本机缺少 ffprobe 且无法校验文件头');
    }
    return { path, sizeBytes: BigInt(file.size), mimeType: 'video/mp4' as const, width, height, durationMs };
  }

  async createVideoThumbnailFile(inputPath: string) {
    this.assertStagingPath(inputPath);
    const framePath = await this.createStagingPath('.jpg');
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-ss', '0', '-i', inputPath, '-an', '-frames:v', '1',
        '-vf', `scale=${THUMBNAIL_MAX_EDGE}:${THUMBNAIL_MAX_EDGE}:force_original_aspect_ratio=decrease`,
        '-q:v', '5', framePath,
      ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      return await this.imageProcessing.run(() => this.createThumbnailUnlocked(framePath));
    } finally {
      await this.deleteStaged(framePath).catch(() => undefined);
    }
  }

  async resizeMaskFile(objectKey: string, width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('遮罩目标尺寸无效');
    return this.imageProcessing.run(async () => {
      const outputPath = await this.createStagingPath('.png');
      try {
        await sharp(this.resolveKey(objectKey), { limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true })
          .resize(width, height, { fit: 'fill', kernel: 'nearest' })
          .png({ compressionLevel: 6 })
          .toFile(outputPath);
        return outputPath;
      } catch (error) {
        await this.deleteStaged(outputPath);
        throw error;
      }
    });
  }

  async saveStaged(userId: string, stagedPath: string, mimeType: string) {
    this.assertStagingPath(stagedPath);
    const ext = MIME_EXT[mimeType] ?? extname(mimeType);
    const objectKey = `${userId}/${randomUUID()}${ext}`;
    return this.saveStagedKey(objectKey, stagedPath);
  }

  async saveStagedKey(objectKey: string, stagedPath: string) {
    this.assertStagingPath(stagedPath);
    if (!/^[a-z0-9][a-z0-9/_-]*\.[a-z0-9]+$/i.test(objectKey)) throw new Error('非法对象键');
    const fullPath = this.resolveKey(objectKey);
    await mkdir(dirname(fullPath), { recursive: true });
    await rm(fullPath, { force: true });
    await rename(stagedPath, fullPath);
    const file = await stat(fullPath);
    return { objectKey, sizeBytes: BigInt(file.size) };
  }

  async objectSize(objectKey: string) {
    return (await stat(this.resolveKey(objectKey))).size;
  }

  async createStylePresetPreviewFile(inputPath: string) {
    this.assertStagingPath(inputPath);
    return this.imageProcessing.run(async () => {
      const outputPath = await this.createStagingPath('.webp');
      try {
        const info = await sharp(inputPath, { limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true })
          .rotate()
          .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: 'cover' })
          .webp({ quality: THUMBNAIL_QUALITY, effort: 2 })
          .toFile(outputPath);
        const file = await stat(outputPath);
        return { path: outputPath, sizeBytes: BigInt(file.size), mimeType: 'image/webp' as const, width: info.width, height: info.height };
      } catch (error) {
        await this.deleteStaged(outputPath);
        throw error;
      }
    });
  }

  filePath(objectKey: string) { return this.resolveKey(objectKey); }
  createReadStream(objectKey: string, range?: { start: number; end: number }) {
    return createReadStream(this.resolveKey(objectKey), range);
  }
  async hashStaged(path: string) { this.assertStagingPath(path); return this.hashFile(path); }
  async hashObject(objectKey: string) { return this.hashFile(this.resolveKey(objectKey)); }
  async delete(objectKey: string) { await rm(this.resolveKey(objectKey), { force: true }); }
  async deleteMany(objectKeys: string[], concurrency = 8) {
    let index = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), objectKeys.length) }, async () => {
      while (index < objectKeys.length) await this.delete(objectKeys[index++]);
    });
    await Promise.all(workers);
  }
  async deleteStaged(path: string) { this.assertStagingPath(path); await rm(path, { force: true }); }

  async deleteUser(userId: string) {
    const path = resolve(this.root, userId);
    if (!path.startsWith(`${this.root}${sep}`) || path === this.stagingRoot || isStagingObjectPath(this.root, path)) throw new Error('非法存储路径');
    await rm(path, { recursive: true, force: true });
  }

  private sharpImage(path: string) {
    return sharp(path, { limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true });
  }

  private async inspectSharp(image: ReturnType<typeof sharp>, claimedMime?: string) {
    const meta = await image.metadata();
    const mime = meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}`;
    if (!MIME_EXT[mime] || (claimedMime && claimedMime !== mime)) throw new Error('仅支持 PNG、JPEG 和 WebP 图片');
    if (!meta.width || !meta.height || meta.width > MAX_IMAGE_EDGE || meta.height > MAX_IMAGE_EDGE) throw new Error('图片尺寸无效或超过 8192 像素');
    return { mimeType: mime, width: meta.width, height: meta.height, orientation: meta.orientation };
  }

  private async inspectImageFileUnlocked(path: string, claimedMime?: string) {
    const file = await stat(path);
    if (file.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 20 MiB');
    const meta = await this.inspectSharp(this.sharpImage(path), claimedMime);
    return { path, sizeBytes: BigInt(file.size), mimeType: meta.mimeType, width: meta.width, height: meta.height };
  }

  private async createThumbnailUnlocked(inputPath: string) {
    return this.writeThumbnailFrom(this.sharpImage(inputPath));
  }

  private async writeThumbnailFrom(image: ReturnType<typeof sharp>) {
    const outputPath = await this.createStagingPath('.webp');
    try {
      const info = await image
        .clone()
        .rotate()
        .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: THUMBNAIL_QUALITY, effort: 2 })
        .toFile(outputPath);
      const file = await stat(outputPath);
      return { path: outputPath, sizeBytes: BigInt(file.size), mimeType: 'image/webp' as const, width: info.width, height: info.height };
    } catch (error) {
      await this.deleteStaged(outputPath);
      throw error;
    }
  }

  private assertStagingPath(path: string) {
    const absolute = resolve(path);
    if (!absolute.startsWith(`${this.stagingRoot}${sep}`)) throw new Error('非法临时文件路径');
  }

  private resolveKey(objectKey: string) {
    const path = resolve(this.root, objectKey);
    if (!path.startsWith(`${this.root}${sep}`) || isStagingObjectPath(this.root, path)) throw new Error('非法对象键');
    return path;
  }

  private async hashFile(path: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  }
}

export async function isMp4File(path: string) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    if (bytesRead < 8) return false;
    return buffer.toString('ascii', 4, 8) === 'ftyp';
  } finally {
    await handle.close();
  }
}

export function videoInfoFromFfprobe(payload: unknown) {
  const object = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
  const streams = Array.isArray(object?.streams) ? object.streams : [];
  const video = streams.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).codec_type === 'video') as Record<string, unknown> | undefined;
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new Error('视频尺寸无效或超过 8192 像素');
  }
  const format = object?.format && typeof object.format === 'object' && !Array.isArray(object.format) ? object.format as Record<string, unknown> : undefined;
  const duration = Number(format?.duration ?? video?.duration);
  const durationMs = Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null;
  return { width, height, durationMs };
}

function isStagingObjectPath(root: string, path: string) {
  const relative = path.slice(root.length).replaceAll('\\', '/').replace(/^\//, '');
  return relative === '.staging' || relative.startsWith('.staging/') || relative.startsWith('.staging-');
}

function needsReencode(orientation?: number) {
  return Boolean(orientation && orientation !== 1);
}

function resizeLongEdge(value?: number) {
  if (!Number.isInteger(value) || value == null || value < 1) return undefined;
  return Math.min(value, MAX_IMAGE_EDGE);
}

function encodeNormalized(
  image: ReturnType<typeof sharp>,
  mimeType: string,
  options: { maxLongEdge?: number; mask?: boolean; quality: 'normal' | 'compact' },
) {
  let output = image.rotate();
  if (options.maxLongEdge) {
    output = output.resize({
      width: options.maxLongEdge,
      height: options.maxLongEdge,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: options.mask ? 'nearest' : 'lanczos3',
    });
  }
  const quality = options.quality === 'compact' ? COMPACT_QUALITY : options.maxLongEdge ? DOWNSIZE_QUALITY : 90;
  if (mimeType === 'image/jpeg') return output.jpeg({ quality });
  if (mimeType === 'image/png') return output.png({ compressionLevel: options.quality === 'compact' ? 9 : 6 });
  return output.webp({ quality, effort: 2 });
}

async function probeVideo(path: string) {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    throw new Error('无法解析视频文件');
  }
}
