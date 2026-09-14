import { parseDurationToken } from './duration';

export const MAX_QUOTA_POINTS = 1_000_000;
export const DEFAULT_POINT_MULTIPLIER = 1;
export const MAX_POINT_MULTIPLIER = 100;

export function pointMultiplier(multipliers: unknown, key: string | undefined): number {
  if (!key) return DEFAULT_POINT_MULTIPLIER;
  if (!multipliers || typeof multipliers !== 'object' || Array.isArray(multipliers)) return DEFAULT_POINT_MULTIPLIER;
  const value = (multipliers as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_POINT_MULTIPLIER) return DEFAULT_POINT_MULTIPLIER;
  return value;
}

export type PointsForGenerationArgs = {
  mediaKind: 'IMAGE' | 'VIDEO';
  costPerUnit: number;
  count: number;
  durationSeconds?: number;
  size?: string;
  quality?: string;
  /** 显式指定倍率查找键（图片按分辨率档位 label，如 '1K'）；缺省时图片用 size、视频用 quality。 */
  multiplierKey?: string;
  pointMultipliers?: unknown;
};

export function pointsForGeneration(args: PointsForGenerationArgs): number {
  const key = args.multiplierKey ?? (args.mediaKind === 'VIDEO' ? args.quality : args.size);
  const multiplier = pointMultiplier(args.pointMultipliers, key);
  const base = args.mediaKind === 'VIDEO'
    ? args.costPerUnit * (args.durationSeconds ?? 0)
    : args.costPerUnit * args.count;
  return Math.ceil(base * multiplier);
}

export type QuotaPolicy = {
  groupId: string;
  name: string;
  window: string;
  windowSeconds: number;
  points: number;
};

export type QuotaEventView = { createdAt: Date; points: number };

export function parseQuotaWindow(value: unknown) {
  return parseDurationToken(value, {
    invalidType: '生成额度窗口格式无效',
    invalidFormat: '生成额度窗口必须使用整数加 h/d/w/m，例如 5h、1d、2w、1m',
    outOfRange: '生成额度窗口必须在 1 小时到 12 个月之间',
  });
}

export function parseQuotaPoints(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_QUOTA_POINTS) {
    throw new Error('生成额度积分必须为 1-1000000 的整数');
  }
  return value;
}

export function parseQuotaPair(window: unknown, points: unknown) {
  const windowEmpty = window === undefined || window === null || (typeof window === 'string' && !window.trim());
  const pointsEmpty = points === undefined || points === null;
  if (windowEmpty && pointsEmpty) return { quotaWindow: null, quotaPoints: null };
  if (windowEmpty || pointsEmpty) throw new Error('生成额度的窗口和积分必须同时填写或同时留空');
  return { quotaWindow: parseQuotaWindow(window).value, quotaPoints: parseQuotaPoints(points) };
}

export function quotaPoliciesFromGroups(groups: Array<{ id: string; name: string; quotaWindow: string | null; quotaPoints: number | null }>): QuotaPolicy[] {
  return groups.flatMap((group) => {
    if (!group.quotaWindow || group.quotaPoints == null) return [];
    try {
      const window = parseQuotaWindow(group.quotaWindow);
      if (group.quotaPoints < 1 || group.quotaPoints > MAX_QUOTA_POINTS) return [];
      return [{ groupId: group.id, name: group.name, window: window.value, windowSeconds: window.seconds, points: group.quotaPoints }];
    } catch {
      return [];
    }
  });
}

export function eventsInWindow(events: QuotaEventView[], now: Date, windowSeconds: number) {
  const since = new Date(now.getTime() - windowSeconds * 1000);
  return events.filter((event) => event.createdAt.getTime() > since.getTime()).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

export function usedPoints(events: QuotaEventView[]) {
  return events.reduce((sum, event) => sum + event.points, 0);
}

export function retryAfterSeconds(inWindow: QuotaEventView[], windowSeconds: number, limit: number, incoming: number, now: Date) {
  let remaining = usedPoints(inWindow);
  if (remaining + incoming <= limit) return 0;
  for (const event of inWindow) {
    remaining -= event.points;
    const freesAt = event.createdAt.getTime() + windowSeconds * 1000;
    if (remaining + incoming <= limit) return Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000));
  }
  return windowSeconds;
}

export function evaluatePolicies(policies: QuotaPolicy[], events: QuotaEventView[], incoming: number, now = new Date()) {
  const failures = policies.flatMap((policy) => {
    const inWindow = eventsInWindow(events, now, policy.windowSeconds);
    const used = usedPoints(inWindow);
    if (used + incoming <= policy.points) return [];
    return [{ policy, used, retryAfterSeconds: retryAfterSeconds(inWindow, policy.windowSeconds, policy.points, incoming, now) }];
  });
  if (!failures.length) return { ok: true as const };
  const worst = failures.reduce((current, next) => next.retryAfterSeconds > current.retryAfterSeconds ? next : current);
  return { ok: false as const, policy: worst.policy, used: worst.used, retryAfterSeconds: worst.retryAfterSeconds };
}
