import { MAX_PROVIDER_PROMPT, adminStylePreset, isStylePresetId, providerPromptFor, publicStylePreset, slugifyStylePresetId, STYLE_PRESETS, stylePresetAllowedForMode, stylePresetById, stylePresetFromParameters, stylePresetPreviewUrl } from './style-presets';

describe('style presets', () => {
  it('exposes the built-in catalog ids in a stable order', () => {
    expect(STYLE_PRESETS.map((item) => item.id)).toEqual(['cinematic', 'storybook', 'anime', 'figurine', 'ink-wash', 'clay', 'film', 'product']);
  });

  it('accepts kebab-case ids and rejects malformed ones', () => {
    expect(isStylePresetId('ink-wash')).toBe(true);
    expect(isStylePresetId('ghibli style')).toBe(false);
    expect(stylePresetById('storybook')?.nameZh).toBe('水彩绘本');
  });

  it('slugifies English names for new presets', () => {
    expect(slugifyStylePresetId('Ink Wash')).toBe('ink-wash');
    expect(slugifyStylePresetId('  Cinematic  ')).toBe('cinematic');
    expect(slugifyStylePresetId('水彩绘本')).toBe('');
  });

  it('uses a stored custom preview url and falls back to bundled samples', () => {
    expect(stylePresetPreviewUrl({ id: 'cinematic' })).toBe('/style-presets/cinematic.webp');
    expect(stylePresetPreviewUrl({ id: 'custom', previewObjectKey: 'style-presets/custom.webp', updatedAt: new Date(1_700_000_000_000) }))
      .toBe('/api/v1/style-presets/custom/preview?v=1700000000000');
    expect(publicStylePreset(STYLE_PRESETS[0]).previewUrl).toBe('/style-presets/cinematic.webp');
    expect(adminStylePreset({ ...STYLE_PRESETS[0], sortOrder: 0, previewObjectKey: null }).hasCustomPreview).toBe(false);
  });

  it('reads a snapshotted suffix from job parameters, then falls back to the built-in catalog', () => {
    expect(stylePresetFromParameters({ stylePresetId: 'custom', styleSuffix: 'clay look' })).toEqual({ suffix: 'clay look' });
    expect(stylePresetFromParameters({ stylePresetId: 'custom', styleSuffixEn: 'clay look', styleSuffixZh: '黏土风' })).toEqual({ suffix: 'clay look' });
    expect(stylePresetFromParameters({ stylePresetId: 'film' })?.suffix).toBe(stylePresetById('film')!.suffix);
    expect(stylePresetFromParameters({ stylePresetId: 'gone' })).toBeUndefined();
  });

  it('allows presets only for text-to-image and image edit', () => {
    expect(stylePresetAllowedForMode('TEXT_TO_IMAGE')).toBe(true);
    expect(stylePresetAllowedForMode('IMAGE_EDIT')).toBe(true);
    expect(stylePresetAllowedForMode('INPAINT')).toBe(false);
    expect(stylePresetAllowedForMode('TEXT_TO_VIDEO')).toBe(false);
  });

  it('leaves the prompt unchanged without a preset', () => {
    expect(providerPromptFor('TEXT_TO_IMAGE', '  一只橘猫  ', null)).toBe('一只橘猫');
    expect(providerPromptFor('IMAGE_EDIT', '改成晚上', undefined)).toBe('改成晚上');
  });

  it('appends a Chinese style line for text-to-image', () => {
    const result = providerPromptFor('TEXT_TO_IMAGE', '一只橘猫坐在窗台', 'cinematic');
    expect(result.startsWith('一只橘猫坐在窗台\n\n画面风格：')).toBe(true);
    expect(result).toContain(stylePresetById('cinematic')!.suffix);
  });

  it('uses a live suffix object instead of the built-in catalog when provided', () => {
    const result = providerPromptFor('TEXT_TO_IMAGE', '一只橘猫', { suffix: 'admin custom look' });
    expect(result).toBe('一只橘猫\n\n画面风格：admin custom look');
  });

  it('appends an English style line when the prompt has no CJK', () => {
    const result = providerPromptFor('TEXT_TO_IMAGE', 'an orange cat on a windowsill', 'film');
    expect(result.startsWith('an orange cat on a windowsill\n\nVisual style: ')).toBe(true);
    expect(result).toContain(stylePresetById('film')!.suffix);
  });

  it('wraps image-edit prompts as a restyle while keeping the user instruction', () => {
    const result = providerPromptFor('IMAGE_EDIT', '改成晚上，去掉路人', 'storybook');
    expect(result.startsWith('改成晚上，去掉路人\n\n将整张图转绘为以下风格')).toBe(true);
    expect(result).toContain(stylePresetById('storybook')!.suffix);
  });

  it('fills a restyle-only prompt when image edit has no user text', () => {
    const result = providerPromptFor('IMAGE_EDIT', '  ', 'figurine');
    expect(result.startsWith('将整张图转绘为以下风格')).toBe(true);
    expect(result).toContain(stylePresetById('figurine')!.suffix);
    expect(result.length).toBeLessThanOrEqual(MAX_PROVIDER_PROMPT);
  });
});
