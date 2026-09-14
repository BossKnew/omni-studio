export const MAX_PROVIDER_PROMPT = 8000;
export const MAX_STYLE_PRESETS = 50;
export const MAX_STYLE_PRESET_NAME = 32;
export const MAX_STYLE_PRESET_SUFFIX = 2000;
export const NONE_STYLE_PRESET_PREVIEW = '/style-presets/none.webp';

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const STYLE_PRESET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type StylePreset = {
  id: string;
  nameZh: string;
  nameEn: string;
  suffix: string;
  previewObjectKey?: string | null;
  sortOrder?: number;
  updatedAt?: Date;
};

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'cinematic',
    nameZh: '电影感',
    nameEn: 'Cinematic',
    suffix: 'cinematic film still, anamorphic widescreen, shallow depth of field, golden rim light, fine film grain, cinematic color grade',
  },
  {
    id: 'storybook',
    nameZh: '水彩绘本',
    nameEn: 'Storybook',
    suffix: 'hand-painted watercolor storybook illustration, soft edges, gouache background, warm golden natural light, nostalgic fairy-tale mood',
  },
  {
    id: 'anime',
    nameZh: '二次元',
    nameEn: 'Anime',
    suffix: 'Japanese anime still frame, cel shading, clean line art, large expressive eyes, cinematic lighting, saturated but clean colors',
  },
  {
    id: 'figurine',
    nameZh: '3D 手办',
    nameEn: 'Figurine',
    suffix: 'collectible 3D character figurine, glossy PVC, acrylic display base, cabinet lighting, macro product photography',
  },
  {
    id: 'ink-wash',
    nameZh: '国风水墨',
    nameEn: 'Ink wash',
    suffix: 'Chinese ink wash painting, xuan paper texture, layered ink values, generous negative space, light blue-green tint, expressive but controlled brushwork',
  },
  {
    id: 'clay',
    nameZh: '黏土',
    nameEn: 'Clay',
    suffix: 'stop-motion clay animation, handmade plasticine texture, rounded forms, soft studio lighting, macro photography',
  },
  {
    id: 'film',
    nameZh: '胶片',
    nameEn: 'Film',
    suffix: '35mm color negative portrait, warm skin tones, light grain and light leak, natural window light, documentary photography, shallow depth of field',
  },
  {
    id: 'product',
    nameZh: '电商产品',
    nameEn: 'Product',
    suffix: 'commercial product photography, seamless white backdrop, softbox lighting, sharp material detail, catalog composition, centered subject',
  },
];

const STYLE_PRESET_BY_ID = new Map(STYLE_PRESETS.map((item) => [item.id, item]));

export function stylePresetById(id: string | null | undefined): StylePreset | undefined {
  if (!id) return undefined;
  return STYLE_PRESET_BY_ID.get(id);
}

export function isStylePresetId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64 && STYLE_PRESET_ID.test(id);
}

export function slugifyStylePresetId(value: string) {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return isStylePresetId(slug) ? slug : '';
}

export function stylePresetPreviewObjectKey(id: string) {
  return `style-presets/${id}.webp`;
}

export function stylePresetPreviewUrl(row: Pick<StylePreset, 'id' | 'previewObjectKey' | 'updatedAt'>) {
  if (row.previewObjectKey) {
    const version = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Date.now();
    return `/api/v1/style-presets/${encodeURIComponent(row.id)}/preview?v=${version}`;
  }
  return STYLE_PRESET_BY_ID.has(row.id) ? `/style-presets/${row.id}.webp` : NONE_STYLE_PRESET_PREVIEW;
}

export function publicStylePreset(row: StylePreset) {
  return {
    id: row.id,
    nameZh: row.nameZh,
    nameEn: row.nameEn,
    previewUrl: stylePresetPreviewUrl(row),
  };
}

export function adminStylePreset(row: StylePreset) {
  return {
    ...publicStylePreset(row),
    suffix: row.suffix,
    sortOrder: row.sortOrder ?? 0,
    hasCustomPreview: Boolean(row.previewObjectKey),
  };
}

export function stylePresetFromParameters(parameters: unknown): Pick<StylePreset, 'suffix'> | undefined {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return undefined;
  const candidate = parameters as Record<string, unknown>;
  const suffix =
    (typeof candidate.styleSuffix === 'string' && candidate.styleSuffix)
    || (typeof candidate.styleSuffixEn === 'string' && candidate.styleSuffixEn)
    || (typeof candidate.styleSuffixZh === 'string' && candidate.styleSuffixZh)
    || '';
  if (suffix) return { suffix };
  return stylePresetById(typeof candidate.stylePresetId === 'string' ? candidate.stylePresetId : undefined);
}

function suffixLocale(prompt: string): 'zh' | 'en' {
  const trimmed = prompt.trim();
  if (!trimmed || CJK.test(trimmed)) return 'zh';
  return 'en';
}

export function providerPromptFor(mode: string, prompt: string, style?: string | Pick<StylePreset, 'suffix'> | null): string {
  const trimmed = prompt.trim();
  const preset = typeof style === 'string' ? stylePresetById(style) : style ?? undefined;
  if (!preset) return trimmed;
  const locale = suffixLocale(trimmed);
  const suffix = preset.suffix;
  if (mode === 'IMAGE_EDIT') {
    const restyle = locale === 'zh'
      ? `将整张图转绘为以下风格，保留原图主体、构图、姿态、服饰、场景结构与身份，只改变画风、材质与光色：${suffix}`
      : `Restyle the entire image in the following look, keeping the subject, composition, pose, clothing, scene structure, and identity, changing only medium, materials, and light: ${suffix}`;
    return trimmed ? `${trimmed}\n\n${restyle}` : restyle;
  }
  const styleLine = locale === 'zh' ? `画面风格：${suffix}` : `Visual style: ${suffix}`;
  return trimmed ? `${trimmed}\n\n${styleLine}` : styleLine;
}

export function stylePresetAllowedForMode(mode: string) {
  return mode === 'TEXT_TO_IMAGE' || mode === 'IMAGE_EDIT';
}
