import { optionLabelMapFromItems, parseOptionLabelMap } from './option-labels';

describe('option labels', () => {
  it('parses stored maps', () => {
    expect(parseOptionLabelMap({ auto: { zh: '自动', en: 'Auto' }, '1024x1024': { zh: '1:1' } })).toEqual({
      auto: { zh: '自动', en: 'Auto' },
      '1024x1024': { zh: '1:1', en: '' },
    });
  });

  it('rejects duplicate values and overlong labels', () => {
    expect(() => optionLabelMapFromItems([{ value: 'auto', zh: '自动', en: '' }, { value: 'auto', zh: '重复', en: '' }])).toThrow('取值不能重复');
    expect(() => optionLabelMapFromItems([{ value: 'auto', zh: 'x'.repeat(33), en: '' }])).toThrow('显示文案不能超过 32 个字符');
  });

  it('treats a missing table as empty', () => {
    expect(parseOptionLabelMap(null)).toEqual({});
    expect(optionLabelMapFromItems([])).toEqual({});
  });
});
