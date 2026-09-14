import { promptHash } from './prompt-hash';

describe('promptHash', () => {
  it('fingerprints UTF-8 prompts without storing the original text as a unique key', () => {
    expect(promptHash('一只橘猫')).toMatch(/^[0-9a-f]{64}$/);
    expect(promptHash('一只橘猫')).toBe(promptHash('一只橘猫'));
    expect(promptHash('一只橘猫')).not.toBe(promptHash('一只橘猫 '));
  });
});
