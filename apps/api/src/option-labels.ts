export const OPTION_LABELS_KEY = 'option_labels';
export const MAX_OPTION_LABELS = 100;
export const MAX_OPTION_VALUE = 64;
export const MAX_OPTION_LABEL = 32;

export type OptionLabelEntry = { zh: string; en: string };
export type OptionLabelMap = Record<string, OptionLabelEntry>;
export type OptionLabelItem = { value: string; zh: string; en: string };

function cleanLabel(value: unknown) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('显示文案必须为文本');
  const label = value.trim();
  if (label.length > MAX_OPTION_LABEL) throw new Error(`显示文案不能超过 ${MAX_OPTION_LABEL} 个字符`);
  return label;
}

export function cleanOptionValue(value: unknown) {
  if (typeof value !== 'string') throw new Error('取值必须为文本');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_OPTION_VALUE) throw new Error(`取值长度必须为 1-${MAX_OPTION_VALUE} 个字符`);
  return trimmed;
}

export function parseOptionLabelMap(value: unknown): OptionLabelMap {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('显示文案格式无效');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OPTION_LABELS) throw new Error(`显示文案最多 ${MAX_OPTION_LABELS} 条`);
  const result: OptionLabelMap = {};
  for (const [rawKey, rawEntry] of entries) {
    const key = cleanOptionValue(rawKey);
    if (result[key]) throw new Error('取值不能重复');
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) throw new Error('显示文案格式无效');
    const entry = rawEntry as Record<string, unknown>;
    result[key] = { zh: cleanLabel(entry.zh), en: cleanLabel(entry.en) };
  }
  return result;
}

export function optionLabelItemsFromMap(map: OptionLabelMap): OptionLabelItem[] {
  return Object.entries(map)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, labels]) => ({ value, zh: labels.zh, en: labels.en }));
}

export function optionLabelMapFromItems(items: unknown): OptionLabelMap {
  if (!Array.isArray(items)) throw new Error('显示文案必须为列表');
  if (items.length > MAX_OPTION_LABELS) throw new Error(`显示文案最多 ${MAX_OPTION_LABELS} 条`);
  const result: OptionLabelMap = {};
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('显示文案格式无效');
    const row = item as Record<string, unknown>;
    const value = cleanOptionValue(row.value);
    if (result[value]) throw new Error('取值不能重复');
    result[value] = { zh: cleanLabel(row.zh), en: cleanLabel(row.en) };
  }
  return result;
}
