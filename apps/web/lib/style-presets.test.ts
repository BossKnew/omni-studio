import assert from 'node:assert/strict';
import test from 'node:test';
import { stylePresetById, stylePresetLabel, type StylePreset } from './style-presets.ts';

const sample: StylePreset[] = [
  { id: 'cinematic', nameZh: '电影感', nameEn: 'Cinematic', previewUrl: '/style-presets/cinematic.webp' },
  { id: 'clay', nameZh: '黏土', nameEn: 'Clay', previewUrl: '/api/v1/style-presets/clay/preview?v=1' },
];

test('looks up presets from the loaded catalog', () => {
  assert.equal(stylePresetById(sample, 'clay')?.nameZh, '黏土');
  assert.equal(stylePresetLabel(stylePresetById(sample, 'clay')!, 'en'), 'Clay');
  assert.equal(stylePresetById(sample, 'missing'), undefined);
  assert.equal(stylePresetById(sample, ''), undefined);
});
