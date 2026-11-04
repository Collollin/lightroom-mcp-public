import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, writeFile, mkdir, rm, symlink, link, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { verifyExportResult } from '../src/export-results.js';
import { createCallToolHandler } from '../src/tool-handler.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'export-manifest-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function rendered(input_index: number, path: string, requested_id: string | number = '1') {
  return { input_index, requested_id, photo_id: `resolved-${input_index}`, status: 'rendered', path };
}
function wire(results: unknown[]) { return { destination: root, results }; }
async function jpegFile(name = 'actual-renamed.jpg', width = 7, height = 3) {
  const bytes = jpeg.encode({ width, height, data: Buffer.alloc(width * height * 4, 128) }, 80).data;
  const path = join(root, name);
  await writeFile(path, bytes);
  return { path, bytes };
}

it('returns actual JPEG bytes and dimensions while preserving repeated requested occurrences and resolved identities', async () => {
  const a = await jpegFile();
  const b = await jpegFile('unpredicted-suffix.jpg', 3, 5);
  const result = await verifyExportResult(wire([rendered(1, a.path, 1), rendered(2, b.path, '1')]), { photo_ids: [1, '1'] });
  expect(result).toMatchObject({ success: true, complete: true, exported: 2, checksum_policy: 'not_computed',
    counts: { completed: 2, skipped: 0, failed: 0, missing: 0 }, results: [
      { input_index: 1, requested_id: 1, photo_id: 'resolved-1', status: 'completed', output: {
        path: a.path, bytes: a.bytes.length, dimensions: { status: 'decoded', width: 7, height: 3 } } },
      { input_index: 2, requested_id: '1', photo_id: 'resolved-2', output: { path: b.path, dimensions: { width: 3, height: 5 } } },
    ] });
  expect(result.remaining_ids).toBeUndefined();
});

it.each(['png', 'tiff'] as const)('reads stored %s header dimensions from the retained file', async (format) => {
  let bytes: Buffer;
  if (format === 'png') {
    bytes = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
    bytes.writeUInt32BE(17, 16); bytes.writeUInt32BE(9, 20);
  } else {
    bytes = Buffer.alloc(46);
    bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4); bytes.writeUInt16LE(2, 8);
    for (const [offset, tag, value] of [[10, 256, 17], [22, 257, 9]]) {
      bytes.writeUInt16LE(tag, offset); bytes.writeUInt16LE(4, offset + 2);
      bytes.writeUInt32LE(1, offset + 4); bytes.writeUInt32LE(value, offset + 8);
    }
  }
  const path = join(root, `raster.${format}`); await writeFile(path, bytes);
  const result = await verifyExportResult(wire([rendered(1, path)]), { photo_ids: ['1'], format });
  expect(result.results[0]).toMatchObject({ status: 'completed', output: {
    bytes: bytes.length, dimensions: { status: 'decoded', width: 17, height: 9 },
  } });
});

it('reports original dimensions unavailable without inventing catalog metadata', async () => {
  const path = join(root, 'original.ARW'); await writeFile(path, 'original bytes');
  const result = await verifyExportResult(wire([rendered(1, path)]), { photo_ids: ['1'], format: 'original' });
  expect(result.results[0]).toMatchObject({ status: 'completed', output: { path, bytes: 14,
    dimensions: { status: 'unavailable', reason: 'original_format_not_decoded' } } });
});

it('retains missing and canceled rows and derives all totals from the final outcomes', async () => {
  const { path } = await jpegFile();
  const result = await verifyExportResult(wire([
    rendered(1, path), { input_index: 2, requested_id: 'absent', status: 'missing', reason: 'photo_not_found' },
    { input_index: 3, requested_id: '/alias', photo_id: 'vc-9', status: 'skipped', reason: 'canceled' },
    { input_index: 4, requested_id: '1', photo_id: 'vc-9', status: 'skipped', reason: 'existing_file' },
  ]), { photo_ids: ['1', 'absent', '/alias', '1'] });
  expect(result).toMatchObject({ success: false, complete: false, exported: 1,
    counts: { completed: 1, skipped: 2, failed: 0, missing: 1 }, remaining_ids: ['vc-9'] });
});

it('honors existing-file skips without reading or claiming the preexisting artifact', async () => {
  const result = await verifyExportResult(wire([{ input_index: 1, requested_id: '1', photo_id: '9',
    status: 'skipped', reason: 'existing_file' }]), { photo_ids: ['1'], on_existing: 'skip' });
  expect(result).toMatchObject({ success: true, complete: true, exported: 0, counts: { skipped: 1 } });
  expect(result.results[0]).not.toHaveProperty('output');
});

it('handles all-missing inputs as a complete unsuccessful manifest', async () => {
  const result = await verifyExportResult(wire([{ input_index: 1, requested_id: 'absent', status: 'missing', reason: 'photo_not_found' }]), { photo_ids: ['absent'] });
  expect(result).toMatchObject({ success: false, complete: true, exported: 0, counts: { missing: 1 } });
});

it.each(['same path', 'symlink', 'hardlink'] as const)('attributes only the last writer for %s aliases', async (alias) => {
  const { path } = await jpegFile();
  const other = alias === 'same path' ? path : join(root, 'alias.jpg');
  if (alias === 'symlink') await symlink(path, other);
  if (alias === 'hardlink') await link(path, other);
  const result = await verifyExportResult(wire([rendered(1, path), rendered(2, other)]), { photo_ids: ['1', '1'], on_existing: 'overwrite' });
  expect(result.results[0]).toMatchObject({ status: 'failed', rendered_path: path,
    error: { code: 'output_superseded' }, superseded_by_input_index: 2 });
  expect(result.results[0]).not.toHaveProperty('output');
  expect(result.results[1]).toHaveProperty('status', 'completed');
  expect(result).toMatchObject({ success: false, exported: 1, counts: { completed: 1, failed: 1 } });
});

it('invalidates a prior deliverable after a failed overwrite while a later skip retains it', async () => {
  const { path } = await jpegFile();
  const failure = { input_index: 2, requested_id: '1', photo_id: '2', status: 'failed', attempted_path: path,
    error: { code: 'render_failed', message: 'write failed' } };
  const failed = await verifyExportResult(wire([rendered(1, path), failure]), { photo_ids: ['1', '1'], on_existing: 'overwrite' });
  expect(failed.results[0]).toMatchObject({ status: 'failed', error: { code: 'output_invalidated' }, superseded_by_input_index: 2 });
  expect(failed.exported).toBe(0);
  const skipped = await verifyExportResult(wire([rendered(1, path), { input_index: 2, requested_id: '1', photo_id: '2',
    status: 'skipped', reason: 'existing_file' }]), { photo_ids: ['1', '1'], on_existing: 'skip' });
  expect(skipped).toMatchObject({ success: true, exported: 1, counts: { completed: 1, skipped: 1 } });
});

it('preserves independent successes beside missing, empty, directory, invalid-header, and render failures', async () => {
  const good = await jpegFile(); const empty = join(root, 'empty'); const bad = join(root, 'invalid.jpg');
  await writeFile(empty, ''); await writeFile(bad, 'not an image'); await mkdir(join(root, 'directory'));
  const paths = [good.path, join(root, 'absent'), empty, join(root, 'directory'), bad];
  const result = await verifyExportResult(wire([...paths.map((path, index) => rendered(index + 1, path)),
    { input_index: 6, requested_id: '1', photo_id: '6', status: 'failed', error: { code: 'rendition_missing', message: 'No rendition' } },
  ]), { photo_ids: Array<string>(6).fill('1') });
  expect(result.results.map((row) => row.status === 'failed' ? row.error.code : row.status)).toEqual([
    'completed', 'output_missing', 'output_unreadable', 'output_unreadable', 'decode_failed', 'rendition_missing',
  ]);
  expect(result.counts).toEqual({ completed: 1, skipped: 0, failed: 5, missing: 0 });
});

it('rejects a different format even when its dimension header is valid', async () => {
  const { path } = await jpegFile();
  const result = await verifyExportResult(wire([rendered(1, path)]), { photo_ids: ['1'], format: 'png' });
  expect(result.results[0]).toMatchObject({ status: 'failed', error: { code: 'decode_failed' } });
});

describe('receipt boundary', () => {
  it.each([
    { success: true, exported: 1 },
    { destination: '/out', results: [{ input_index: 1, requested_id: '1', status: 'completed' }] },
    { destination: '/out', results: [{ ...rendered(1, '/out/a'), photo_id: undefined }] },
  ])('rejects legacy or malformed plugin replies', async (value) => {
    await expect(verifyExportResult(value, { photo_ids: ['1'] })).rejects.toThrow(/matching Lightroom plugin/);
  });
  it.each([
    [], [rendered(2, '/out/a')], [rendered(1, '/out/a', 1)], [rendered(1, 'relative')],
    [rendered(1, '/out/a'), rendered(1, '/out/b')],
  ].map((results) => [results]))('rejects missing, reordered, mismatched or relative occurrences (%#)', async (results) => {
    await expect(verifyExportResult(wire(results), { photo_ids: ['1'] })).rejects.toThrow(/does not match/);
  });
});

it('finalizes export receipts at the tool boundary and fails old plugins usefully', async () => {
  const { path } = await jpegFile();
  for (const [value, isError] of [[wire([rendered(1, path)]), false], [{ exported: 1 }, true]] as const) {
    const call = createCallToolHandler({ isReady: () => true, dispatcher: { call: async () => ({ id: '1', result: value }) } });
    const response = await call('export_photos', { photo_ids: ['1'], destination: root });
    expect(Boolean(response.isError)).toBe(isError);
    if (isError) expect(response.content[0].text).toContain('matching Lightroom plugin');
    else expect(JSON.parse(response.content[0].text)).toMatchObject({ exported: 1, results: [{ status: 'completed' }] });
  }
});


it('verifies large originals by stable stats and refuses oversized raster reads', async () => {
  const path = join(root, 'large-original');
  await writeFile(path, 'x');
  await truncate(path, 513 * 1024 * 1024);
  const receipt = wire([rendered(1, path)]);
  const original = await verifyExportResult(receipt, { photo_ids: ['1'], format: 'original' });
  expect(original.results[0]).toMatchObject({ status: 'completed', output: { bytes: 513 * 1024 * 1024,
    dimensions: { status: 'unavailable' } } });
  const raster = await verifyExportResult(receipt, { photo_ids: ['1'] });
  expect(raster.results[0]).toMatchObject({ status: 'failed', error: { code: 'output_unreadable' } });
});

it('counts no retained deliveries when the final writer reports success but its file is gone', async () => {
  const path = join(root, 'gone.jpg');
  const result = await verifyExportResult({ ...wire([rendered(1, path), rendered(2, path)]), exported: 999, success: true },
    { photo_ids: ['1', '1'], on_existing: 'overwrite' });
  expect(result).toMatchObject({ exported: 0, success: false, complete: true, counts: { failed: 2 } });
  expect(result.results.map((row) => row.status === 'failed' && row.error.code)).toEqual(['output_superseded', 'output_missing']);
});


it('reads BigTIFF stored dimensions within TIFF exports', async () => {
  const bytes = Buffer.alloc(96);
  bytes.write('II'); bytes.writeUInt16LE(43, 2); bytes.writeUInt16LE(8, 4);
  bytes.writeBigUInt64LE(16n, 8); bytes.writeBigUInt64LE(2n, 16);
  for (const [offset, tag, value] of [[24, 256, 17], [44, 257, 9]]) {
    bytes.writeUInt16LE(tag, offset); bytes.writeUInt16LE(4, offset + 2);
    bytes.writeBigUInt64LE(1n, offset + 4); bytes.writeUInt32LE(value, offset + 12);
  }
  const path = join(root, 'big.tiff'); await writeFile(path, bytes);
  const result = await verifyExportResult(wire([rendered(1, path)]), { photo_ids: ['1'], format: 'tiff' });
  expect(result.results[0]).toMatchObject({ status: 'completed', output: {
    bytes: bytes.length, dimensions: { status: 'decoded', width: 17, height: 9 },
  } });
});
