import { pollDelayMs } from './domain-constants';

describe('pollDelayMs', () => {
  it('backs off from 1s to 10s', () => {
    expect(pollDelayMs(0)).toBe(1_000);
    expect(pollDelayMs(1)).toBe(2_000);
    expect(pollDelayMs(2)).toBe(5_000);
    expect(pollDelayMs(3)).toBe(10_000);
    expect(pollDelayMs(99)).toBe(10_000);
  });
});
