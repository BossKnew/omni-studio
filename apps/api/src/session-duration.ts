import { parseDurationToken } from './duration';

export const DEFAULT_USER_SESSION_DURATION = '7d';
export const ADMIN_SESSION_SECONDS = 24 * 60 * 60;
export const SESSION_INDEX_SECONDS = 366 * 24 * 60 * 60;

export function parseSessionDuration(value: unknown) {
  return parseDurationToken(value, {
    invalidType: '会话有效期格式无效',
    invalidFormat: '会话有效期必须使用整数加 h/d/w/m，例如 12h、7d、2w、1m',
    outOfRange: '会话有效期必须在 1 小时到 12 个月之间',
  });
}
