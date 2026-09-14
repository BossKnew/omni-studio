import {
  DEFAULT_UPLOAD_MAX_LONG_EDGE,
  parseUploadImagePolicy,
  parseUploadMaxLongEdge,
  uploadImagePolicyFromSetting,
} from './upload-image-policy';

describe('upload image policy', () => {
  it.each([1024, 2048, 4096, 6144, 8192])('accepts %s', (edge) => {
    expect(parseUploadMaxLongEdge(edge)).toBe(edge);
    expect(parseUploadImagePolicy({ maxLongEdge: edge })).toEqual({ maxLongEdge: edge });
  });

  it.each([1000, 4097, 0, 8193, 4096.5, 'nope', null, undefined])('rejects %s', (value) => {
    expect(() => parseUploadMaxLongEdge(value)).toThrow('上传图片最长边必须是 1024 到 8192 之间、步长为 256 的整数');
  });

  it('rejects a non-object policy payload', () => {
    expect(() => parseUploadImagePolicy('4096')).toThrow('上传图片策略格式无效');
    expect(() => parseUploadImagePolicy(null)).toThrow('上传图片策略格式无效');
  });

  it('falls back to 4096 when the stored value is missing or invalid', () => {
    expect(uploadImagePolicyFromSetting(null)).toEqual({ maxLongEdge: DEFAULT_UPLOAD_MAX_LONG_EDGE });
    expect(uploadImagePolicyFromSetting({ maxLongEdge: 999 })).toEqual({ maxLongEdge: DEFAULT_UPLOAD_MAX_LONG_EDGE });
  });
});
