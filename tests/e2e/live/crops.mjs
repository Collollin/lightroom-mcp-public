#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import jpeg from "../../../server/node_modules/jpeg-js/index.js";
import { readFlushedSettings } from "./lib/catalog-db.mjs";
import { compareCrop, displayedPixels, parseSavedSettings, withoutCrop } from "./lib/crop-oracle.mjs";
import { openLiveSession, requireFixtureId } from "./lib/live-catalog.mjs";

const { session, marker } = await openLiveSession();
const originals = new Map();
const evidence = [];
let addedMask;
let preservationId;
let originalExposure;
try {
  assert(process.argv[2], "Usage: node tests/e2e/live/crops.mjs OUTPUT_DIRECTORY");
  const destination = path.resolve(process.argv[2]);
  fs.mkdirSync(destination, { recursive: true });
  assert.equal(fs.readdirSync(destination).length, 0, "Use a new or empty output directory so every render is fresh");
  const ids = Array.from({ length: 8 }, (_, i) => requireFixtureId(marker, `orient_${i + 1}`));
  const flushId = requireFixtureId(marker, "wide_plain");
  const metadata = (id) => session.toolOrThrow("get_photo_metadata", { photo_id: id, sections: ["developSettings"] });
  const raw = (id) => session.toolOrThrow("set_develop_settings", { photo_id: id, settings: originals.get(id) });
  const full = { kind: "bounds", left: 0, top: 0, right: 1, bottom: 1 };
  const asymmetric = { kind: "bounds", left: 0.1, top: 0.2, right: 0.8, bottom: 0.7 };

  async function stored(id) {
    const row = await readFlushedSettings(session, id, flushId);
    assert(row, "preservation requires a readable full develop-settings row");
    return parseSavedSettings(row.text);
  }

  async function crop(id, value) {
    const answer = await session.toolOrThrow("set_photo_crop", { photo_id: id, crop: value });
    assert.equal(answer.data.success, true, answer.text);
    assert.equal(answer.data.verification, "settings_and_metadata");
    return answer.data;
  }

  async function render(id, n, label, bounds, source) {
    const folder = path.join(destination, label);
    fs.mkdirSync(folder, { recursive: true });
    await session.toolOrThrow("export_photos", { photo_ids: [id], destination: folder, format: "jpeg", on_existing: "overwrite" });
    const file = path.join(folder, `orient_${n}.jpg`);
    const rendered = jpeg.decode(fs.readFileSync(file));
    const comparison = compareCrop(source, rendered, bounds);
    assert(comparison.meanAbsoluteError < 0.02, `${label} pixel error ${comparison.meanAbsoluteError}`);
    evidence.push({ label, file, ...comparison });
    fs.writeFileSync(path.join(destination, "results.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence.at(-1)));
    return comparison;
  }

  for (let n = 1; n <= 8; n++) {
    const id = ids[n - 1];
    const initial = (await metadata(id)).data;
    const saved = initial.developSettings?.crop ?? {};
    originals.set(id, {
      CropLeft: saved.CropLeft ?? 0, CropTop: saved.CropTop ?? 0,
      CropRight: saved.CropRight ?? 1, CropBottom: saved.CropBottom ?? 1, CropAngle: saved.CropAngle ?? 0,
    });
    assert.equal(originals.get(id).CropAngle, 0, "orientation fixtures must have zero straighten");
    await crop(id, full);
    const before = withoutCrop(await stored(id));
    const original = jpeg.decode(fs.readFileSync(initial.path));
    const source = displayedPixels(original, n);
    const result = await crop(id, asymmetric);
    assert.deepEqual(result.uncropped_dimensions, { width: source.width, height: source.height });
    for (const key of ["left", "top", "right", "bottom"]) assert(Math.abs(result.bounds[key] - asymmetric[key]) <= 1e-6);
    const exported = await render(id, n, `orientation-${n}`, asymmetric, source);
    const rendered = jpeg.decode(fs.readFileSync(path.join(destination, `orientation-${n}`, `orient_${n}.jpg`)));
    const wrongOrientation = displayedPixels(original, n % 2 === 0 ? n - 1 : n + 1);
    assert(compareCrop(wrongOrientation, rendered, asymmetric).meanAbsoluteError >= 0.02,
      "wrong orientation must fail the pixel oracle");
    assert(compareCrop(source, rendered, { left: 0.2, top: 0.2, right: 0.9, bottom: 0.7 }).meanAbsoluteError
      >= 0.02, "wrong bounds must fail the pixel oracle");
    assert.throws(() => compareCrop(source, { ...rendered, width: rendered.width + 3 }, asymmetric),
      "wrong dimensions must fail the pixel oracle");
    assert.equal(result.cropped_dimensions.width, exported.width);
    assert.equal(result.cropped_dimensions.height, exported.height);
    assert.deepEqual(withoutCrop(await stored(id)), before, "unrelated develop settings and masks survive cropping");
    const repeated = await crop(id, asymmetric);
    assert.equal(repeated.changed, false);
    assert.deepEqual(repeated.cropped_dimensions, result.cropped_dimensions);
    await raw(id);
  }

  for (const [n, value, expected] of [
    [6, { kind: "aspect", width: 4, height: 5, anchor: { x: 0, y: 1 } }, { left: 0, top: 0.25, right: 1, bottom: 1 }],
    [1, { kind: "aspect", width: 2, height: 1, anchor: { x: 1, y: 0 } }, { left: 0, top: 0, right: 1, bottom: 5 / 6 }],
  ]) {
    const id = ids[n - 1];
    const initial = (await metadata(id)).data;
    await crop(id, asymmetric);
    const result = await crop(id, value);
    for (const key of ["left", "top", "right", "bottom"]) assert(Math.abs(result.bounds[key] - expected[key]) <= 1e-6);
    const exported = await render(id, n, `aspect-${n}`, expected, displayedPixels(jpeg.decode(fs.readFileSync(initial.path)), n));
    assert.equal(result.cropped_dimensions.width, exported.width);
    assert.equal(result.cropped_dimensions.height, exported.height);
    assert.equal((await crop(id, value)).changed, false);
    await raw(id);
  }

  preservationId = ids[0];
  originalExposure = (await metadata(preservationId)).data.developSettings?.exposure;
  assert.equal(typeof originalExposure, "number", "exposure must be readable for restoration");
  await session.toolOrThrow("set_develop_settings", { photo_id: preservationId, settings: { Exposure2012: 0.4 } });
  addedMask = (await session.toolOrThrow("create_gradient_mask", {
    photo_id: preservationId, shape: "linear", start: { x: 0.2, y: 0.2 }, end: { x: 0.7, y: 0.8 },
    name: "Crop preservation fixture", adjustments: { exposure: 0.5 },
  })).data.mask_id;
  assert(addedMask, "preservation check must create a mask with an id");
  const preserved = withoutCrop(await stored(preservationId));
  assert.equal(preserved.Exposure2012, 0.4, "the preservation snapshot must contain the seeded exposure");
  assert(Array.isArray(preserved.MaskGroupBasedCorrections)
    && preserved.MaskGroupBasedCorrections.some(mask => mask.CorrectionID === addedMask),
  "the preservation snapshot must contain the seeded nonempty mask");
  await crop(preservationId, asymmetric);
  assert.deepEqual(withoutCrop(await stored(preservationId)), preserved, "seeded edit and mask survive cropping");
  const beforeInvalid = await metadata(preservationId);
  const invalid = await session.tool("set_photo_crop", {
    photo_id: preservationId, crop: { kind: "bounds", left: 0.8, top: 0, right: 0.2, bottom: 1 },
  });
  assert(invalid.isError, "invalid bounds must fail before mutation");
  assert.deepEqual((await metadata(preservationId)).data.developSettings, beforeInvalid.data.developSettings);
  await session.toolOrThrow("set_develop_settings", { photo_id: preservationId, settings: { CropAngle: 2 } });
  const beforeAngle = (await metadata(preservationId)).data.developSettings;
  const angle = await session.tool("set_photo_crop", { photo_id: preservationId, crop: asymmetric });
  assert(angle.isError, "nonzero straighten must fail before mutation");
  assert.deepEqual((await metadata(preservationId)).data.developSettings, beforeAngle);
  console.log("crop checks passed; view preservation is verified separately by the run owner");
} finally {
  const failures = [];
  if (addedMask) {
    try { await session.toolOrThrow("delete_masks", { photo_id: preservationId, mask_ids: [addedMask] }); }
    catch (error) { failures.push(error); }
  }
  if (originalExposure !== undefined) {
    try { await session.toolOrThrow("set_develop_settings", { photo_id: preservationId, settings: { Exposure2012: originalExposure } }); }
    catch (error) { failures.push(error); }
  }
  for (const [photo_id, settings] of originals) {
    try { await session.toolOrThrow("set_develop_settings", { photo_id, settings }); }
    catch (error) { failures.push(error); }
  }
  await session.stop();
  if (failures.length) throw new AggregateError(failures, "Fixture restoration failed");
}
