#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openLiveSession, requireFixtureId } from "./lib/live-catalog.mjs";
import { requireThrowawayCatalog } from "./lib/catalog-guard.mjs";

requireThrowawayCatalog();
const { session, marker, catalogPath } = await openLiveSession();
const root = path.join(path.dirname(catalogPath), `export-manifest-${randomUUID()}`);
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, "OWNED.txt"),
  "Export manifest live checker owns this folder and its imported copies/virtual copy. Keep it until the disposable catalog is discarded.\n");
const reports = [];

async function tool(name, args) {
  assert.equal(requireThrowawayCatalog(), catalogPath);
  const answer = await session.tool(name, args, { timeoutMs: 300_000 });
  reports.push({ tool: name, args, answer });
  fs.writeFileSync(path.join(root, "manifests.json"), JSON.stringify(reports, null, 2) + "\n");
  assert.equal(answer.isError, false, answer.text);
  return answer.data;
}

function verify(manifest, requested, format) {
  assert.equal(manifest.results.length, requested.length);
  assert.equal(manifest.checksum_policy, "not_computed");
  const counts = { completed: 0, skipped: 0, failed: 0, missing: 0 };
  const canceled = [];
  for (const [index, row] of manifest.results.entries()) {
    assert.equal(row.input_index, index + 1);
    assert.equal(row.requested_id, requested[index]);
    assert.ok(Object.hasOwn(counts, row.status), JSON.stringify(row));
    counts[row.status]++;
    if (row.status === "skipped" && row.reason === "canceled") canceled.push(row.photo_id);
    if (row.status !== "completed") {
      assert.equal(row.output, undefined);
      continue;
    }
    assert.ok(path.isAbsolute(row.output.path));
    assert.ok(fs.statSync(row.output.path).isFile());
    assert.equal(fs.statSync(row.output.path).size, row.output.bytes);
    if (format === "original") {
      assert.deepEqual(row.output.dimensions, { status: "unavailable", reason: "original_format_not_decoded" });
    } else {
      const dimensions = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", row.output.path], { encoding: "utf8" });
      assert.deepEqual(row.output.dimensions, { status: "decoded",
        width: Number(dimensions.match(/pixelWidth:\s*(\d+)/)?.[1]),
        height: Number(dimensions.match(/pixelHeight:\s*(\d+)/)?.[1]),
      });
    }
  }
  assert.deepEqual(manifest.counts, counts);
  assert.equal(manifest.exported, counts.completed);
  assert.equal(manifest.complete, canceled.length === 0);
  assert.equal(manifest.success, canceled.length === 0 && counts.failed === 0 && counts.missing === 0);
  assert.deepEqual(manifest.remaining_ids ?? [], canceled);
}

async function runExport(name, ids, format = "jpeg", on_existing = "rename") {
  const destination = path.join(root, name);
  const result = await tool("export_photos", { photo_ids: ids, destination, format, on_existing, width: 256, height: 256 });
  assert.equal(result.destination, destination);
  verify(result, ids, format);
  return result;
}

try {
  const source = requireFixtureId(marker, "wide_plain");
  const portrait = requireFixtureId(marker, "orient_6");
  const raw = requireFixtureId(marker, "arw_14bit");
  for (const format of ["jpeg", "png", "tiff", "original"]) {
    const ids = format === "original" ? [source, raw] : [source, portrait];
    const result = await runExport(`formats-${format}`, ids, format);
    assert.equal(result.exported, ids.length);
    assert.equal(result.success, true);
  }
  const missing = `missing-${randomUUID()}`;
  const mixed = await runExport("mixed", [missing, source, source]);
  assert.equal(mixed.results[0].status, "missing");
  assert.equal(mixed.exported, 2);
  const allMissing = await runExport("all-missing", [missing, missing]);
  assert.equal(allMissing.counts.missing, 2);
  assert.equal(fs.existsSync(allMissing.destination), false);

  const ownedPaths = [];
  for (const [folder, fixture] of [["a", "wide_plain"], ["b", "orient_6"]]) {
    requireFixtureId(marker, fixture);
    const directory = path.join(root, "sources", folder);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "collision.jpg");
    fs.copyFileSync(marker.fixtures[fixture].path, file);
    assert.equal((await tool("import_photos", { source_path: file })).imported, 1);
    ownedPaths.push(file);
  }
  const ownedIds = [];
  for (const photo_id of ownedPaths) ownedIds.push(String((await tool("get_photo_metadata", { photo_id })).id));
  const copy = await tool("create_virtual_copies", { photo_ids: [ownedIds[0]], copy_name: "Export manifest fixture" });
  const copyId = String(copy.copies[0].copy_id);
  assert.notEqual(copyId, ownedIds[0]);
  await tool("set_develop_settings", { photo_id: copyId, settings: { Exposure2012: 1 } });
  const ids = [ownedIds[0], ownedIds[1], copyId, ownedIds[0]];
  const targets = [];
  for (const id of ids) {
    const probe = await runExport("target-probe", [id], "jpeg", "overwrite");
    assert.equal(probe.exported, 1);
    targets.push(path.relative(probe.destination, probe.results[0].output.path));
  }
  const targetCount = new Set(targets).size;
  assert.ok(targetCount < ids.length, "The repeated source must exercise an actual collision");
  for (const policy of ["rename", "skip", "overwrite"]) {
    const first = await runExport(`collision-${policy}`, ids, "jpeg", policy);
    assert.deepEqual(first.results.map((row) => row.photo_id), ids);
    if (policy === "rename") {
      assert.equal(first.exported, 4);
      assert.equal(new Set(first.results.map((row) => row.output.path)).size, 4);
      const second = await runExport(`collision-${policy}`, ids, "jpeg", policy);
      assert.equal(second.exported, 4);
      assert.equal(new Set([...first.results, ...second.results].map((row) => row.output.path)).size, 8);
    } else if (policy === "skip") {
      assert.equal(first.exported, targetCount);
      assert.equal(first.counts.skipped, ids.length - targetCount);
      const seen = new Set();
      for (const [index, row] of first.results.entries()) {
        assert.equal(row.status, seen.has(targets[index]) ? "skipped" : "completed");
        if (row.status === "skipped") assert.equal(row.reason, "existing_file");
        seen.add(targets[index]);
      }
      const kept = first.results.filter((row) => row.status === "completed")
        .map((row) => [row.output.path, fs.readFileSync(row.output.path)]);
      const second = await runExport(`collision-${policy}`, ids, "jpeg", policy);
      assert.equal(second.exported, 0);
      assert.equal(second.counts.skipped, 4);
      for (const [keptPath, bytes] of kept) assert.deepEqual(fs.readFileSync(keptPath), bytes);
    } else {
      assert.equal(first.exported, targetCount);
      assert.equal(first.counts.failed, ids.length - targetCount);
      for (const [index, row] of first.results.entries()) {
        const last = targets.lastIndexOf(targets[index]);
        if (last === index) assert.equal(row.status, "completed");
        else {
          assert.equal(row.error.code, "output_superseded");
          assert.equal(row.superseded_by_input_index, last + 1);
          assert.equal(row.rendered_path, first.results[last].output.path);
        }
      }
    }
  }
  fs.writeFileSync(path.join(root, "manifests.json"), JSON.stringify(reports, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, root, manifests: reports.length, ownedIds, copyId }));
} finally {
  // Catalog deletion uses selection/UI flows. Retain owned sources and copies together in this disposable catalog.
  console.log(`Owned export fixtures retained at ${root}; discard them with the throwaway catalog.`);
  await session.stop();
}
