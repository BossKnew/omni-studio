import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { StorageService } from './storage.service';
import {
  STYLE_PRESETS,
  adminStylePreset,
  isStylePresetId,
  MAX_STYLE_PRESETS,
  publicStylePreset,
  slugifyStylePresetId,
  stylePresetPreviewObjectKey,
} from './style-presets';

type StylePresetInput = {
  id?: string;
  nameZh: string;
  nameEn: string;
  suffix: string;
};

@Injectable()
export class StylePresetsService {
  constructor(private prisma: PrismaService, private storage: StorageService) {}

  async listPublic() {
    return { items: (await this.ordered()).map(publicStylePreset) };
  }

  async listAdmin() {
    return { items: (await this.ordered()).map(adminStylePreset) };
  }

  async get(id: string) {
    const row = await this.prisma.stylePreset.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('风格预设不存在');
    return row;
  }

  async create(actorId: string, input: StylePresetInput) {
    const count = await this.prisma.stylePreset.count();
    if (count >= MAX_STYLE_PRESETS) throw new BadRequestException(`风格预设最多 ${MAX_STYLE_PRESETS} 个`);
    const id = await this.allocateId(input.id, input.nameEn || input.nameZh);
    const last = await this.prisma.stylePreset.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const row = await this.prisma.stylePreset.create({
      data: {
        id,
        nameZh: input.nameZh,
        nameEn: input.nameEn,
        suffix: input.suffix,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    await this.audit(actorId, 'style-preset.created', row.id);
    return adminStylePreset(row);
  }

  async update(actorId: string, id: string, input: Partial<StylePresetInput>) {
    await this.get(id);
    const row = await this.prisma.stylePreset.update({
      where: { id },
      data: {
        ...(input.nameZh !== undefined ? { nameZh: input.nameZh } : {}),
        ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
        ...(input.suffix !== undefined ? { suffix: input.suffix } : {}),
      },
    });
    await this.audit(actorId, 'style-preset.updated', id);
    return adminStylePreset(row);
  }

  async remove(actorId: string, id: string) {
    const row = await this.get(id);
    await this.prisma.stylePreset.delete({ where: { id } });
    if (row.previewObjectKey) await this.storage.delete(row.previewObjectKey).catch(() => undefined);
    await this.audit(actorId, 'style-preset.deleted', id, { nameZh: row.nameZh, nameEn: row.nameEn });
    return { ok: true };
  }

  async move(actorId: string, id: string, direction: 'up' | 'down') {
    const rows = await this.ordered();
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw new NotFoundException('风格预设不存在');
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= rows.length) return adminStylePreset(rows[index]);
    const next = [...rows];
    const [item] = next.splice(index, 1);
    next.splice(swapWith, 0, item);
    await this.prisma.$transaction(next.map((row, sortOrder) => this.prisma.stylePreset.update({ where: { id: row.id }, data: { sortOrder } })));
    await this.audit(actorId, 'style-preset.moved', id, { direction });
    return adminStylePreset({ ...item, sortOrder: swapWith });
  }

  async savePreview(actorId: string, id: string, stagedPath: string, claimedMime?: string) {
    let normalized: { path: string } | undefined;
    let preview: { path: string } | undefined;
    try {
      await this.get(id);
      normalized = await this.storage.normalizeImageFile(stagedPath, claimedMime);
      preview = await this.storage.createStylePresetPreviewFile(normalized.path);
      const objectKey = stylePresetPreviewObjectKey(id);
      await this.storage.saveStagedKey(objectKey, preview.path);
      preview = undefined;
      const row = await this.prisma.stylePreset.update({ where: { id }, data: { previewObjectKey: objectKey } });
      await this.audit(actorId, 'style-preset.preview.updated', id);
      return adminStylePreset(row);
    } catch (error) {
      if (preview) await this.storage.deleteStaged(preview.path).catch(() => undefined);
      if (error instanceof NotFoundException || error instanceof BadRequestException || error instanceof ConflictException) throw error;
      throw new BadRequestException((error as Error).message);
    } finally {
      await this.storage.deleteStaged(stagedPath).catch(() => undefined);
      if (normalized) await this.storage.deleteStaged(normalized.path).catch(() => undefined);
    }
  }

  async previewFile(id: string) {
    const row = await this.get(id);
    if (!row.previewObjectKey) throw new NotFoundException();
    try {
      return { objectKey: row.previewObjectKey, mimeType: 'image/webp' as const, sizeBytes: await this.storage.objectSize(row.previewObjectKey) };
    } catch {
      throw new NotFoundException();
    }
  }

  async ensureSeeded() {
    const count = await this.prisma.stylePreset.count();
    if (count) return;
    await this.prisma.stylePreset.createMany({
      data: STYLE_PRESETS.map((item, sortOrder) => ({
        id: item.id,
        nameZh: item.nameZh,
        nameEn: item.nameEn,
        suffix: item.suffix,
        sortOrder,
      })),
      skipDuplicates: true,
    });
  }

  private async ordered() {
    await this.ensureSeeded();
    return this.prisma.stylePreset.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  }

  private async allocateId(requested: string | undefined, fromName: string) {
    const explicit = requested && isStylePresetId(requested) ? requested : '';
    const base = explicit || slugifyStylePresetId(fromName) || `style-${randomBytes(4).toString('hex')}`;
    if (!await this.prisma.stylePreset.findUnique({ where: { id: base } })) return base;
    if (explicit) throw new ConflictException('风格预设 ID 已存在');
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base.slice(0, 60)}-${index}`;
      if (isStylePresetId(candidate) && !await this.prisma.stylePreset.findUnique({ where: { id: candidate } })) return candidate;
    }
    const fallback = `style-${randomBytes(4).toString('hex')}`;
    if (await this.prisma.stylePreset.findUnique({ where: { id: fallback } })) throw new ConflictException('风格预设 ID 已存在');
    return fallback;
  }

  private audit(actorId: string, action: string, targetId: string, metadata?: { nameZh?: string; nameEn?: string; direction?: 'up' | 'down' }) {
    return this.prisma.auditLog.create({ data: { actorId, action, targetType: 'style-preset', targetId, ...(metadata ? { metadata } : {}) } });
  }
}
