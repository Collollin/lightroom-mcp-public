import { describe, expect, it, jest } from '@jest/globals';
import jpeg from 'jpeg-js';
import { Worker } from 'node:worker_threads';
import { previewFixture } from './preview-fixture.js';
import { createCallToolHandler } from '../src/tool-handler.js';

const width = 2400;
const height = 1600;
const encoded = jpeg.encode({ width, height, data: Buffer.alloc(width * height * 4, 127) }, 70).data;

function cachedPreview() {
  return createCallToolHandler({
    isReady: () => true,
    dispatcher: {
      call: async () => ({
        id: 'oversized-cache',
        result: {
          photo_id: 1, requested_size: 64, width, height, bytes: encoded.length,
          image: { mime_type: 'image/jpeg', data: encoded.toString('base64') },
        },
      }),
    },
  });
}

describe('persistent oversized cached preview', () => {
  it('returns a decodable full frame within the declared edge and byte limits', async () => {
    const result = await cachedPreview()('get_photo_preview', { photo_id: 1, size: 64 });
    expect(result.isError).toBeUndefined();
    const image = result.content[1];
    if (image.type !== 'image') throw new Error('Expected a JPEG preview');
    const bytes = Buffer.from(image.data, 'base64');
    const decoded = jpeg.decode(bytes, { tolerantDecoding: false });
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(2000);
    expect(bytes.length).toBeLessThanOrEqual(3.5 * 1024 * 1024);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      width: decoded.width, height: decoded.height, bytes: bytes.length,
    });
  });

  it('obtains a feasible region before bounding the oversized full frame', async () => {
    const result = await cachedPreview()('get_photo_preview', {
      photo_id: 1, size: 512, region: { x: 0, y: 0, width: 0.25, height: 0.25 },
    });
    expect(result.isError).toBeUndefined();
    const image = result.content[1];
    if (image.type !== 'image') throw new Error('Expected a JPEG region');
    const decoded = jpeg.decode(Buffer.from(image.data, 'base64'), { tolerantDecoding: false });
    expect([decoded.width, decoded.height]).toEqual([600, 400]);
  });
});

describe('bounded preview sources and batches', () => {
  it('derives output facts from the JPEG and preserves compliant bytes', async () => {
    const fixture = previewFixture();
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1',
      result: { ...fixture, width: 9000, height: 8000, bytes: -1, extra: 'private' } }) } });
    const result = await handler('get_photo_preview', { photo_id: 914 });
    expect(result.isError).toBeUndefined();
    const { image, ...metadata } = fixture;
    expect(JSON.parse(result.content[0].text)).toEqual(metadata);
    expect(result.content[1]).toEqual({ type: 'image', data: image.data, mimeType: image.mime_type });
  });

  it.each([
    { mime_type: 'image/png', data: 'YWJj' },
    { mime_type: 'image/jpeg', data: 'YWJj' },
    { mime_type: 'image/jpeg', data: 'abc' },
    { mime_type: 'image/jpeg', data: 'Zh==' },
    { mime_type: 'image/jpeg', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') },
    { mime_type: 'image/jpeg', data: Buffer.alloc(10 * 1024 * 1024 + 3).toString('base64') },
  ])('isolates malformed and over-cap source without losing later images (%#)', async image => {
    let next = 0;
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1',
      result: ++next === 1 ? { photo_id: 1, image } : previewFixture(2, 256) }) } });
    const result = await handler('get_photo_previews', { photo_ids: [1, 2] });
    const metadata: unknown = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(metadata).toMatchObject({ complete: true, remaining_ids: [], previews: [
      { requested_id: 1, error: expect.stringMatching(/JPEG|base64|10 MiB/) },
      { requested_id: 2, image_index: 1 },
    ] });
    expect(result.content).toHaveLength(2);
  });

  it.each([{}, { photo_id: null }, { photo_id: {} }])('isolates a missing or invalid source photo ID (%#)', async identity => {
    let next = 0;
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1',
      result: ++next === 1 ? { ...identity, image: previewFixture().image } : previewFixture(2, 256) }) } });
    const result = await handler('get_photo_previews', { photo_ids: [1, 2] });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ complete: true, remaining_ids: [], previews: [
      { requested_id: 1, error: 'Lightroom returned no preview photo ID' },
      { requested_id: 2, photo_id: 2, image_index: 1 },
    ] });
    expect(result.content).toHaveLength(2);
  });

  it.each([new Error('source unavailable'), 'source unavailable'])('continues after source acquisition rejects (%#)', async failure => {
    let next = 0;
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => {
      if (++next === 1) throw failure;
      return { id: '2', result: previewFixture(2, 256) };
    } } });
    const result = await handler('get_photo_previews', { photo_ids: [1, 2] });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ complete: true, remaining_ids: [], previews: [
      { requested_id: 1, error: 'source unavailable' }, { requested_id: 2, photo_id: 2, image_index: 1 },
    ] });
    expect(result.content).toHaveLength(2);
  });

  it('does not acquire a source for a request that was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const call = jest.fn(async () => ({ id: '1', result: previewFixture() }));
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call } });
    const result = await handler('get_photo_preview', { photo_id: 1 }, { signal: controller.signal });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Request cancelled' }] });
    expect(call).not.toHaveBeenCalled();
  });

  it('cancels during source acquisition without waiting for the plugin', async () => {
    const controller = new AbortController();
    let acquired: () => void = () => {};
    const started = new Promise<void>(resolve => { acquired = resolve; });
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => {
      acquired();
      return new Promise<never>(() => {});
    } } });
    const pending = handler('get_photo_previews', { photo_ids: [1, 2] }, { signal: controller.signal });
    await started;
    controller.abort();
    expect(await pending).toEqual({ isError: true, content: [{ type: 'text', text: 'Request cancelled' }] });
  });
});


describe('preview operation lifetime', () => {
  it('rejects a source that arrives after the absolute deadline', async () => {
    const now = jest.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => {
        now.mockReturnValue(20_001);
        return { id: '1', result: previewFixture() };
      } } });
      const result = await handler('get_photo_preview', { photo_id: 1 });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('deadline') }]);
    } finally { now.mockRestore(); }
  });

  it('cancels a posted worker job and releases the worker', async () => {
    const controller = new AbortController();
    const originalPost = Worker.prototype.postMessage;
    let active: Worker | undefined;
    let posted: () => void = () => {};
    const started = new Promise<void>(resolve => { posted = resolve; });
    const post = jest.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, job) {
      active = this;
      originalPost.call(this, job);
      posted();
    });
    try {
      const pending = cachedPreview()('get_photo_preview', { photo_id: 1 }, { signal: controller.signal });
      await started;
      controller.abort();
      expect(await pending).toEqual({ isError: true, content: [{ type: 'text', text: 'Request cancelled' }] });
      expect(active?.threadId).toBe(-1);
    } finally { post.mockRestore(); }
  });

  it('continues on the next photo after the active worker exits', async () => {
    const originalPost = Worker.prototype.postMessage;
    const post = jest.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(function (this: Worker, job) {
      originalPost.call(this, job);
      void this.terminate();
    });
    try {
      const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1', result: previewFixture() }) } });
      const result = await handler('get_photo_previews', { photo_ids: [1, 2] });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toMatchObject({ complete: true, remaining_ids: [], previews: [
        { requested_id: 1, error: 'Preview JPEG worker exited before completing' }, { requested_id: 2, image_index: 1 },
      ] });
      expect(result.content).toHaveLength(2);
    } finally { post.mockRestore(); }
  });

  it('returns the in-flight and untouched batch suffix at the absolute deadline', async () => {
    jest.useFakeTimers();
    try {
      let next = 0;
      let reachedSecond: () => void = () => {};
      const started = new Promise<void>(resolve => { reachedSecond = resolve; });
      const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => {
        if (++next === 1) return { id: '1', result: previewFixture(1, 256) };
        reachedSecond();
        return new Promise<never>(() => {});
      } } });
      const pending = handler('get_photo_previews', { photo_ids: [1, 2, 3] });
      await started;
      await jest.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(JSON.parse(result.content[0].text)).toMatchObject({ complete: false, remaining_ids: [2, 3],
        bytes: previewFixture().bytes, previews: [{ requested_id: 1, image_index: 1 }] });
      expect(next).toBe(2);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('terminates a worker when its deadline expires', async () => {
    jest.useFakeTimers();
    const terminate = jest.spyOn(Worker.prototype, 'terminate');
    let posted: () => void = () => {};
    const started = new Promise<void>(resolve => { posted = resolve; });
    const post = jest.spyOn(Worker.prototype, 'postMessage').mockImplementation(() => { posted(); });
    try {
      const pending = cachedPreview()('get_photo_preview', { photo_id: 1 });
      await started;
      await jest.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('deadline');
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally { post.mockRestore(); terminate.mockRestore(); jest.useRealTimers(); }
  });

  it('discards a failed worker and processes the next photo on a fresh worker', async () => {
    const post = jest.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(() => { throw new Error('worker could not accept job'); });
    try {
      const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1', result: previewFixture() }) } });
      const result = await handler('get_photo_previews', { photo_ids: [1, 2] });
      expect(JSON.parse(result.content[0].text)).toMatchObject({ complete: true, remaining_ids: [], previews: [
        { requested_id: 1, error: 'worker could not accept job' }, { requested_id: 2, image_index: 1 },
      ] });
    } finally { post.mockRestore(); }
  });
});

describe('preview output budgets', () => {
  it('refuses metadata that would exceed the serialized transport budget', async () => {
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1',
      result: previewFixture('x'.repeat(16 * 1024 * 1024)) }) } });
    const result = await handler('get_photo_preview', { photo_id: 1 });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Preview response exceeds the 16 MiB transport limit' }] });
  });

  it('preserves the current photo when the remaining budget cannot hold even a one-pixel JPEG', async () => {
    const original = Buffer.from(previewFixture().image.data, 'base64');
    const sizes = [3 * 1024 * 1024, 3 * 1024 * 1024, 2 * 1024 * 1024 - 100];
    let next = 0;
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => {
      const index = next++;
      const source = sizes[index] === undefined ? original : Buffer.concat([original, Buffer.alloc(sizes[index] - original.length)]);
      return { id: String(next), result: { photo_id: next, image: { mime_type: 'image/jpeg', data: source.toString('base64') } } };
    } } });
    const result = await handler('get_photo_previews', { photo_ids: [1, 2, 3, 4, 5] });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ complete: false, remaining_ids: [4, 5],
      bytes: 8 * 1024 * 1024 - 100, previews: [
        { requested_id: 1, image_index: 1 }, { requested_id: 2, image_index: 2 }, { requested_id: 3, image_index: 3 },
      ] });
    expect(result.content).toHaveLength(4);
    expect(next).toBe(4);
  });

  it('normalizes a decodable JPEG above the output byte limit', async () => {
    const original = Buffer.from(previewFixture().image.data, 'base64');
    const source = Buffer.concat([original, Buffer.alloc(4 * 1024 * 1024 - original.length)]);
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1',
      result: { photo_id: 1, image: { mime_type: 'image/jpeg', data: source.toString('base64') } } }) } });
    const result = await handler('get_photo_preview', { photo_id: 1 });
    expect(result.isError).toBeUndefined();
    const image = result.content[1];
    if (image.type !== 'image') throw new Error('Expected bounded JPEG');
    const output = Buffer.from(image.data, 'base64');
    expect(output.length).toBeLessThanOrEqual(3.5 * 1024 * 1024);
    expect(jpeg.decode(output, { tolerantDecoding: false })).toMatchObject({ width: 32, height: 16 });
  });

  it('stops at the aggregate byte budget and preserves the pending suffix', async () => {
    const original = Buffer.from(previewFixture().image.data, 'base64');
    const source = Buffer.concat([original, Buffer.alloc(2 * 1024 * 1024 - original.length)]);
    let next = 0;
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1',
      result: { photo_id: ++next, image: { mime_type: 'image/jpeg', data: source.toString('base64') } } }) } });
    const result = await handler('get_photo_previews', { photo_ids: [1, 2, 3, 4, 5, 6] });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ complete: false, remaining_ids: [5, 6], bytes: 8 * 1024 * 1024 });
    expect(result.content).toHaveLength(5);
    expect(next).toBe(4);
    let bytes = 0;
    for (const image of result.content.slice(1)) {
      if (image.type !== 'image') throw new Error('Expected JPEG');
      const output = Buffer.from(image.data, 'base64');
      expect(jpeg.decode(output, { tolerantDecoding: false })).toMatchObject({ width: 32, height: 16 });
      bytes += output.length;
    }
    expect(bytes).toBe(8 * 1024 * 1024);
  });

  it('refuses an excessive decoded pixel count before image allocation', async () => {
    const source = Buffer.from(previewFixture().image.data, 'base64');
    const frame = source.indexOf(Buffer.from([0xff, 0xc0]));
    expect(frame).toBeGreaterThan(0);
    source.writeUInt16BE(9000, frame + 5);
    source.writeUInt16BE(9000, frame + 7);
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1',
      result: { photo_id: 1, image: { mime_type: 'image/jpeg', data: source.toString('base64') } } }) } });
    const result = await handler('get_photo_preview', { photo_id: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toMatch(/resolution|megapixels/i);
  });
});

describe('JPEG scan validation', () => {
  it.each(['missing scan', 'zero width', 'zero height', 'marker hidden in APP payload'])('rejects %s without producing an image', async variant => {
    let source = Buffer.from(previewFixture().image.data, 'base64');
    const scan = source.indexOf(Buffer.from([0xff, 0xda]));
    const frame = source.indexOf(Buffer.from([0xff, 0xc0]));
    if (variant === 'zero width') source.writeUInt16BE(0, frame + 7);
    if (variant === 'zero height') source.writeUInt16BE(0, frame + 5);
    if (variant === 'missing scan' || variant === 'marker hidden in APP payload') {
      source = Buffer.concat([source.subarray(0, scan), Buffer.from([0xff, 0xd9])]);
      if (variant === 'marker hidden in APP payload') {
        source = Buffer.concat([source.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 6, 0xff, 0xda, 0, 0]), source.subarray(2)]);
      }
    }
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1',
      result: { photo_id: 1, image: { mime_type: 'image/jpeg', data: source.toString('base64') } } }) } });
    const result = await handler('get_photo_preview', { photo_id: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toMatch(/JPEG/);
  });

  it('keeps a valid JPEG with marker-like bytes inside APP metadata', async () => {
    const original = Buffer.from(previewFixture().image.data, 'base64');
    const source = Buffer.concat([original.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 8, 0xff, 0xda, 0xff, 0xd9, 0, 0]), original.subarray(2)]);
    const handler = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1',
      result: { photo_id: 1, image: { mime_type: 'image/jpeg', data: source.toString('base64') } } }) } });
    const result = await handler('get_photo_preview', { photo_id: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: source.toString('base64') });
  });
});
