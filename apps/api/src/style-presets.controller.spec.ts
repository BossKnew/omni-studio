import { BadRequestException } from '@nestjs/common';
import { StylePresetsController } from './style-presets.controller';

describe('StylePresetsController', () => {
  const actor = { id: 'admin-1' } as any;

  it('lists public cards without style suffixes', async () => {
    const presets: any = { listPublic: jest.fn().mockResolvedValue({ items: [{ id: 'cinematic', nameZh: '电影感', nameEn: 'Cinematic', previewUrl: '/style-presets/cinematic.webp' }] }) };
    const result = await new StylePresetsController(presets, {} as any).list();
    expect(result?.items[0]).toEqual(expect.objectContaining({ id: 'cinematic', previewUrl: '/style-presets/cinematic.webp' }));
    expect(result?.items[0]).not.toHaveProperty('suffix');
  });

  it('creates, updates, moves and deletes through the admin API', async () => {
    const presets: any = {
      create: jest.fn().mockResolvedValue({ id: 'oil-paint' }),
      update: jest.fn().mockResolvedValue({ id: 'oil-paint', nameZh: '油画' }),
      move: jest.fn().mockResolvedValue({ id: 'oil-paint', sortOrder: 0 }),
      remove: jest.fn().mockResolvedValue({ ok: true }),
      listAdmin: jest.fn().mockResolvedValue({ items: [] }),
    };
    const controller = new StylePresetsController(presets, {} as any);
    await controller.create(actor, { nameZh: '油画', nameEn: 'Oil paint', suffix: 'oil strokes' });
    await controller.update(actor, 'oil-paint', { nameZh: '油画' });
    await controller.move(actor, 'oil-paint', { direction: 'up' });
    await controller.remove(actor, 'oil-paint');
    expect(presets.create).toHaveBeenCalled();
    expect(presets.move).toHaveBeenCalledWith('admin-1', 'oil-paint', 'up');
    expect(presets.remove).toHaveBeenCalledWith('admin-1', 'oil-paint');
  });

  it('rejects malformed preset ids', () => {
    const controller = new StylePresetsController({} as any, {} as any);
    expect(() => controller.update(actor, 'Bad ID', { nameZh: 'x' })).toThrow(BadRequestException);
    expect(() => controller.remove(actor, '')).toThrow(BadRequestException);
  });
});
