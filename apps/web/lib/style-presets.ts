export type StylePreset = {
  id: string;
  nameZh: string;
  nameEn: string;
  previewUrl: string;
};

export type AdminStylePreset = StylePreset & {
  suffix: string;
  sortOrder: number;
};

export const NONE_STYLE_PRESET_PREVIEW = '/style-presets/none.webp';

export function stylePresetById(items: StylePreset[], id: string | null | undefined): StylePreset | undefined {
  if (!id) return undefined;
  return items.find((item) => item.id === id);
}

export function stylePresetLabel(preset: Pick<StylePreset, 'nameZh' | 'nameEn'>, locale: 'zh' | 'en') {
  return locale === 'en' ? preset.nameEn : preset.nameZh;
}
