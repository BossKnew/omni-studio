const UNITS: Record<string, number> = {
  h: 60 * 60,
  d: 24 * 60 * 60,
  w: 7 * 24 * 60 * 60,
  m: 30 * 24 * 60 * 60,
};

export function parseDurationToken(value: unknown, messages: { invalidType: string; invalidFormat: string; outOfRange: string }) {
  if (typeof value !== 'string') throw new Error(messages.invalidType);
  const normalized = value.trim().toLowerCase();
  const match = /^([1-9]\d{0,2})([hdwm])$/.exec(normalized);
  if (!match) throw new Error(messages.invalidFormat);
  const seconds = Number(match[1]) * UNITS[match[2]];
  if (seconds < UNITS.h || seconds > 12 * UNITS.m) throw new Error(messages.outOfRange);
  return { value: normalized, seconds };
}
