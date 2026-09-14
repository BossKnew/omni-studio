import { parseDurationToken } from './duration';

export const DEFAULT_TRASH_RETENTION = '30d';

export function parseTrashRetention(value: unknown) {
  return parseDurationToken(value, {
    invalidType: '回收站留存时长格式无效',
    invalidFormat: '回收站留存时长必须使用整数加 h/d/w/m，例如 12h、7d、2w、1m',
    outOfRange: '回收站留存时长必须在 1 小时到 12 个月之间',
  });
}

export function trashRetentionFromSetting(value: unknown) {
  try { return parseTrashRetention(value); }
  catch { return parseTrashRetention(DEFAULT_TRASH_RETENTION); }
}
