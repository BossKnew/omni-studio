import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { StylePresetsService } from './style-presets.service';
import { STYLE_PRESETS } from './style-presets';

function row(partial: Partial<typeof STYLE_PRESETS[number]> & { id: string; sortOrder?: number; previewObjectKey?: string | null; updatedAt?: Date } = { id: 'cinematic' }) {
  const preset = STYLE_PRESETS.find((item) => item.id === partial.id) ?? STYLE_PRESETS[0];
  return {
    ...preset,
    ...partial,
    previewObjectKey: partial.previewObjectKey ?? null,
    sortOrder: partial.sortOrder ?? 0,
    createdAt: new Date(),
    updatedAt: partial.updatedAt ?? new Date(),
  };
}

describe('StylePresetsService', () => {
  it('seeds the built-in catalog when the table is empty', async () => {
    const prisma: any = {
      stylePreset: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 8 }),
        findMany: jest.fn().mockResolvedValue(STYLE_PRESETS.map((item, sortOrder) => row({ ...item, sortOrder }))),
      },
    };
    const service = new StylePresetsService(prisma, {} as any);
    const result = await service.listPublic();
    expect(prisma.stylePreset.createMany).toHaveBeenCalled();
    expect(result.items.map((item) => item.id)).toEqual(STYLE_PRESETS.map((item) => item.id));
    expect(result.items[0].previewUrl).toBe('/style-presets/cinematic.webp');
  });

  it('creates a slug from the English name and appends to the end', async () => {
    const created = row({ id: 'oil-paint', nameZh: '油画', nameEn: 'Oil paint', suffix: 'oil paint strokes', sortOrder: 8 });
    const prisma: any = {
      stylePreset: {
        count: jest.fn().mockResolvedValue(8),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ sortOrder: 7 }),
        create: jest.fn().mockResolvedValue(created),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new StylePresetsService(prisma, {} as any);
    const result = await service.create('admin-1', { nameZh: '油画', nameEn: 'Oil paint', suffix: 'oil paint strokes' });
    expect(prisma.stylePreset.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: 'oil-paint', sortOrder: 8 }),
    }));
    expect(result.id).toBe('oil-paint');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'style-preset.created' }) }));
  });

  it('rejects a duplicate explicit id and a full catalog', async () => {
    const prisma: any = {
      stylePreset: {
        count: jest.fn().mockResolvedValueOnce(50).mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue(row()),
      },
    };
    const service = new StylePresetsService(prisma, {} as any);
    await expect(service.create('admin-1', { nameZh: '油画', nameEn: 'Oil', suffix: 'a' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('admin-1', { id: 'cinematic', nameZh: '电影感', nameEn: 'Cinematic', suffix: 'a' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('moves a preset by rewriting sort order', async () => {
    const rows = [
      row({ id: 'cinematic', sortOrder: 0 }),
      row({ id: 'storybook', sortOrder: 1 }),
      row({ id: 'anime', sortOrder: 2 }),
    ];
    const prisma: any = {
      stylePreset: {
        count: jest.fn().mockResolvedValue(3),
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new StylePresetsService(prisma, {} as any);
    await service.move('admin-1', 'storybook', 'up');
    expect(prisma.stylePreset.update.mock.calls.map((call: any) => [call[0].where.id, call[0].data.sortOrder])).toEqual([
      ['storybook', 0],
      ['cinematic', 1],
      ['anime', 2],
    ]);
  });

  it('deletes a preset and its custom preview file', async () => {
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const prisma: any = {
      stylePreset: {
        findUnique: jest.fn().mockResolvedValue(row({ id: 'cinematic', previewObjectKey: 'style-presets/cinematic.webp' })),
        delete: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new StylePresetsService(prisma, storage as any);
    await expect(service.remove('admin-1', 'cinematic')).resolves.toEqual({ ok: true });
    expect(storage.delete).toHaveBeenCalledWith('style-presets/cinematic.webp');
  });

  it('stores an uploaded sample as a square webp preview', async () => {
    const storage = {
      normalizeImageFile: jest.fn().mockResolvedValue({ path: '/tmp/norm.png' }),
      createStylePresetPreviewFile: jest.fn().mockResolvedValue({ path: '/tmp/preview.webp' }),
      saveStagedKey: jest.fn().mockResolvedValue({ objectKey: 'style-presets/cinematic.webp', sizeBytes: 12n }),
      deleteStaged: jest.fn().mockResolvedValue(undefined),
    };
    const updated = row({ id: 'cinematic', previewObjectKey: 'style-presets/cinematic.webp', updatedAt: new Date(1_700_000_000_000) });
    const prisma: any = {
      stylePreset: {
        findUnique: jest.fn().mockResolvedValue(row({ id: 'cinematic' })),
        update: jest.fn().mockResolvedValue(updated),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new StylePresetsService(prisma, storage as any);
    const result = await service.savePreview('admin-1', 'cinematic', '/tmp/upload', 'image/png');
    expect(storage.saveStagedKey).toHaveBeenCalledWith('style-presets/cinematic.webp', '/tmp/preview.webp');
    expect(result.hasCustomPreview).toBe(true);
    expect(result.previewUrl).toContain('/api/v1/style-presets/cinematic/preview?v=');
    expect(storage.deleteStaged).toHaveBeenCalledWith('/tmp/upload');
  });

  it('throws not found for a missing preset', async () => {
    const prisma: any = { stylePreset: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new StylePresetsService(prisma, {} as any);
    await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
