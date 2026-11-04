#!/usr/bin/env node
import assert from "node:assert/strict";
import jpeg from "../../../server/node_modules/jpeg-js/index.js";
import { openLiveSession, requireFixtureId } from "./lib/live-catalog.mjs";

const { session, marker, catalogPath } = await openLiveSession();
const ids = process.argv.slice(2);
if (ids.length === 0) ids.push(...["arw_14bit", "arw_12bit"].map(key => requireFixtureId(marker, key)));
const maxBytes = 3.5 * 1024 * 1024;
const batchBudget = 8 * 1024 * 1024;

function inspect(image, metadata) {
  assert.equal(image?.mimeType, "image/jpeg");
  const encoded = Buffer.from(image.data, "base64");
  const decoded = jpeg.decode(encoded, { useTArray: true, tolerantDecoding: false });
  assert.ok(Math.max(decoded.width, decoded.height) <= 2000);
  assert.ok(encoded.length <= maxBytes);
  assert.equal(metadata.width, decoded.width);
  assert.equal(metadata.height, decoded.height);
  assert.equal(metadata.bytes, encoded.length);
  return { width: decoded.width, height: decoded.height, bytes: encoded.length };
}

async function edits(id) {
  return (await session.toolOrThrow("get_photo_metadata", {
    photo_id: id, sections: ["developSettings"],
  })).data.developSettings;
}

try {
  console.log(JSON.stringify({ catalogPath, ids }));
  const before = await Promise.all(ids.map(edits));
  for (const id of ids) {
    for (const size of [2048, 512, 64]) {
      const result = await session.toolOrThrow("get_photo_preview", { photo_id: id, size });
      console.log(JSON.stringify({ tool: "get_photo_preview", photo_id: id, size,
        ...inspect(result.image, result.data), ms: result.ms }));
    }
    const region = { x: 0.25, y: 0.25, width: 0.25, height: 0.25 };
    const result = await session.toolOrThrow("get_photo_preview", { photo_id: id, size: 512, region });
    console.log(JSON.stringify({ tool: "get_photo_preview", photo_id: id, region,
      ...inspect(result.image, result.data), ms: result.ms }));
  }
  const requested = [ids[0], "/preview-limits-missing-photo.ARW", ids[0], ...ids.slice(1)];
  const result = await session.rpc("tools/call", {
    name: "get_photo_previews", arguments: { photo_ids: requested, size: 512 },
  });
  assert.ok(!result.isError);
  const data = JSON.parse(result.content[0].text);
  const images = result.content.filter(block => block.type === "image");
  assert.equal(data.complete, true);
  assert.deepEqual(data.remaining_ids, []);
  assert.deepEqual(data.previews.map(item => item.requested_id), requested);
  assert.equal(typeof data.previews[1].error, "string");
  assert.equal(data.previews[1].image_index, undefined);
  let bytes = 0;
  let imageIndex = 0;
  for (const [index, row] of data.previews.entries()) {
    if (index === 1) continue;
    assert.equal(row.image_index, ++imageIndex);
    const measured = inspect(images[row.image_index - 1], row);
    bytes += measured.bytes;
    console.log(JSON.stringify({ tool: "get_photo_previews", requested_id: row.requested_id,
      image_index: row.image_index, ...measured }));
  }
  assert.equal(images.length, imageIndex);
  assert.equal(data.bytes, bytes);
  assert.ok(bytes <= batchBudget);
  for (const [index, id] of ids.entries()) assert.deepEqual(await edits(id), before[index]);
  console.log(JSON.stringify({ pass: true, batch_bytes: bytes, develop_settings_unchanged: true }));
} finally {
  await session.stop();
}
