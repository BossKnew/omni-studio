export type ResolutionTier = { label: string; shortEdge: number };
export type ParsedSize = { width: number; height: number };
export type ResolutionEntry = { size: string; width: number; height: number; shortEdge: number; tier: string; ratio: string };
export type ResolutionMatrix = {
  entries: ResolutionEntry[];        // 所有档位 × 比例组合，按 tiers/ratios 传入顺序
  tiers: string[];                   // 档位 label，去重，首次出现顺序
  ratios: string[];                  // 比例，去重，首次出现顺序
  sizeFor(tier: string, ratio: string): string | null;   // 组合出的 size
  sizesForTier(tier: string): string[];                  // 该档位全部 size
  sizesForRatio(ratio: string): string[];                // 该比例全部 size
  partsOf(size: string): ResolutionEntry | null;         // 按 size 字符串查 entry
};

export function parseSize(value: string): ParsedSize | null {
  const match = /^(\d{1,5})x(\d{1,5})$/i.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

export function parseRatio(value: string): ParsedSize | null {
  const match = /^(\d{1,4}):(\d{1,4})$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

function gcd(left: number, right: number): number {
  return right === 0 ? left : gcd(right, left % right);
}

/** 短边 + 比例 -> "WxH"。1K + 3:2 -> 1536x1024；长边按 8 取整。 */
export function computeImageSize(shortEdge: number, ratio: string): string | null {
  const parsed = parseRatio(ratio);
  if (!parsed || !Number.isInteger(shortEdge) || shortEdge < 64 || shortEdge > 8192) return null;
  const divisor = gcd(parsed.width, parsed.height);
  const a = parsed.width / divisor;
  const b = parsed.height / divisor;
  const scale = shortEdge / Math.min(a, b);
  const roundTo8 = (value: number) => Math.max(8, Math.round(value / 8) * 8);
  return `${roundTo8(a * scale)}x${roundTo8(b * scale)}`;
}

/** 档位 × 比例的第一组合出的 size；配置为空时返回 ''。 */
export function firstImageSize(tiers: ResolutionTier[], ratios: string[]): string {
  const tier = tiers[0];
  const ratio = ratios[0];
  if (!tier || !ratio) return '';
  return computeImageSize(tier.shortEdge, ratio) ?? '';
}

export function buildResolutionMatrix(tiers: ResolutionTier[], ratios: string[]): ResolutionMatrix | null {
  if (!tiers.length || !ratios.length) return null;
  const entries: ResolutionEntry[] = [];
  for (const tier of tiers) {
    for (const ratio of ratios) {
      const size = computeImageSize(tier.shortEdge, ratio);
      if (!size) continue;
      const parsed = parseSize(size);
      if (!parsed) continue;
      entries.push({ size, width: parsed.width, height: parsed.height, shortEdge: tier.shortEdge, tier: tier.label, ratio });
    }
  }
  if (!entries.length) return null;
  const tierLabels = [...new Set(entries.map((entry) => entry.tier))];
  const ratioLabels = [...new Set(entries.map((entry) => entry.ratio))];
  return {
    entries,
    tiers: tierLabels,
    ratios: ratioLabels,
    sizeFor(tier, ratio) {
      return entries.find((entry) => entry.tier === tier && entry.ratio === ratio)?.size ?? null;
    },
    sizesForTier(tier) {
      return entries.filter((entry) => entry.tier === tier).map((entry) => entry.size);
    },
    sizesForRatio(ratio) {
      return entries.filter((entry) => entry.ratio === ratio).map((entry) => entry.size);
    },
    partsOf(size) {
      return entries.find((entry) => entry.size === size) ?? null;
    },
  };
}
