import { describe, expect, it } from '@jest/globals';
import jpeg from 'jpeg-js';
import { normalize, MAX_PREVIEW_BYTES } from '../src/preview-worker.js';
import { previewFixture } from './preview-fixture.js';

const source = Buffer.from(previewFixture().image.data, 'base64');

describe('preview JPEG normalization', () => {
  it('keeps an already compliant JPEG byte for byte', () => {
    const result = normalize({ jpeg: source, maxBytes: MAX_PREVIEW_BYTES });
    expect(result).toEqual({ kind: 'image', jpeg: source, width: 32, height: 16 });
  });

  it('crops the original pixels before applying output bounds', () => {
    const large = jpeg.encode({ width: 2400, height: 1600, data: Buffer.alloc(2400 * 1600 * 4, 127) }, 70).data;
    const result = normalize({ jpeg: large, maxBytes: MAX_PREVIEW_BYTES,
      region: { x: 0.5, y: 0.5, width: 0.25, height: 0.25 } });
    if (result.kind !== 'image') throw new Error('Expected region image');
    expect(jpeg.decode(result.jpeg, { tolerantDecoding: false })).toMatchObject({ width: 600, height: 400 });
    expect(result.jpeg.length).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  });

  it('resizes a full frame with its aspect ratio preserved', () => {
    const large = jpeg.encode({ width: 2400, height: 1600, data: Buffer.alloc(2400 * 1600 * 4, 127) }, 70).data;
    const result = normalize({ jpeg: large, maxBytes: MAX_PREVIEW_BYTES });
    if (result.kind !== 'image') throw new Error('Expected bounded image');
    expect(jpeg.decode(result.jpeg, { tolerantDecoding: false })).toMatchObject({ width: 2000, height: 1333 });
  });

  it('returns a budget boundary when even a one-pixel JPEG cannot fit', () => {
    expect(normalize({ jpeg: source, maxBytes: 100 })).toEqual({ kind: 'budget' });
  });

  it('rounds a subpixel region outward to one pixel', () => {
    const result = normalize({ jpeg: source, maxBytes: MAX_PREVIEW_BYTES,
      region: { x: 0.999, y: 0.999, width: 0.001, height: 0.001 } });
    if (result.kind !== 'image') throw new Error('Expected pixel image');
    expect(jpeg.decode(result.jpeg, { tolerantDecoding: false })).toMatchObject({ width: 1, height: 1 });
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from('not a jpeg'),
    Buffer.from([0xff, 0xd8, 0, 0]),
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0]),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]),
    source.subarray(0, source.length - 2),
  ])('rejects malformed, incomplete, or scanless JPEGs (%#)', data => {
    expect(() => normalize({ jpeg: data, maxBytes: MAX_PREVIEW_BYTES })).toThrow();
  });

  it.each(['width', 'height'])('rejects a zero %s', dimension => {
    const data = Buffer.from(source);
    const frame = data.indexOf(Buffer.from([0xff, 0xc0]));
    data.writeUInt16BE(0, frame + (dimension === 'width' ? 7 : 5));
    expect(() => normalize({ jpeg: data, maxBytes: MAX_PREVIEW_BYTES })).toThrow();
  });

  it('skips APP payloads containing marker-like bytes', () => {
    const data = Buffer.concat([source.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 8, 0xff, 0xda, 0xff, 0xd9, 0, 0]), source.subarray(2)]);
    expect(normalize({ jpeg: data, maxBytes: MAX_PREVIEW_BYTES })).toEqual({ kind: 'image', jpeg: data, width: 32, height: 16 });
  });
});
