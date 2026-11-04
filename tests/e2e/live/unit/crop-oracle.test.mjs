import assert from "node:assert/strict";
import test from "node:test";
import { compareCrop, displayedPixels, parseSavedSettings, withoutCrop } from "../lib/crop-oracle.mjs";

const source = { width: 3, height: 2, data: Uint8Array.from([1, 2, 3, 4, 5, 6].flatMap(n => [n, n, n, 255])) };

test("saved Develop rows unwrap Lightroom's assignment before comparing settings", () => {
  const body = '{ Exposure2012 = 0.4, MaskGroupBasedCorrections = { { CorrectionID = "mask-1" } } }';
  const expected = { Exposure2012: 0.4, MaskGroupBasedCorrections: [{ CorrectionID: "mask-1" }] };
  assert.deepEqual(parseSavedSettings(`s = ${body}`), expected);
  assert.deepEqual(parseSavedSettings(body), expected);
  for (const invalid of ["", "unreadable", "s = 0/0", "s = {}", "{ 1, 2 }"]) {
    assert.throws(() => parseSavedSettings(invalid));
  }
});

test("EXIF raster oracle places every pixel with independent expected row orders", () => {
  const expected = [
    [1, 2, 3, 4, 5, 6], [3, 2, 1, 6, 5, 4], [6, 5, 4, 3, 2, 1], [4, 5, 6, 1, 2, 3],
    [1, 4, 2, 5, 3, 6], [4, 1, 5, 2, 6, 3], [6, 3, 5, 2, 4, 1], [3, 6, 2, 5, 1, 4],
  ];
  for (let n = 1; n <= 8; n++) {
    const actual = displayedPixels(source, n);
    assert.equal(actual.width, n >= 5 ? 2 : 3);
    assert.equal(actual.height, n >= 5 ? 3 : 2);
    assert.deepEqual(Array.from(actual.data).filter((_, i) => i % 4 === 0), expected[n - 1]);
  }
});

test("crop comparison rejects wrong dimensions and detects the wrong image region", () => {
  const data = Uint8Array.from({ length: 20 * 20 * 4 }, (_, i) => i % 251);
  const image = { width: 20, height: 20, data };
  assert.equal(compareCrop(image, image, { left: 0, top: 0, right: 1, bottom: 1 }).meanAbsoluteError, 0);
  assert.throws(() => compareCrop(image, { ...image, width: 10 }, { left: 0, top: 0, right: 1, bottom: 1 }));
  assert(compareCrop(image, { ...image, data: new Uint8Array(data.length) },
    { left: 0, top: 0, right: 1, bottom: 1 }).meanAbsoluteError > 0.1);
});

test("preservation comparison excludes crop bookkeeping but retains unrelated settings and masks", () => {
  assert.deepEqual(withoutCrop({ CropLeft: 0, CropAngle: 0, Exposure2012: 0.5, MaskGroupBasedCorrections: [1] }),
    { CropAngle: 0, Exposure2012: 0.5, MaskGroupBasedCorrections: [1] });
});
