#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireThrowawayCatalog } from "./lib/catalog-guard.mjs";
import { storedSettingsRow } from "./lib/catalog-db.mjs";
import { openLiveSession, requireFixtureId } from "./lib/live-catalog.mjs";
import { McpSession } from "./lib/mcp.mjs";

const sorted = (ids) => ids.map(String).sort();
const copyIds = (metadata) => sorted(metadata.virtualCopy?.copyIds ?? []);

export function assertCopyIds(actual, expected, message) {
  assert.deepEqual(sorted(actual), sorted(expected), message);
}

export async function run({ mode = "run", receiptPath } = {}) {
  assert.ok(["run", "prepare", "replay"].includes(mode), "mode must be run, prepare or replay");
  receiptPath = path.resolve(receiptPath ?? path.join(os.tmpdir(), `lrmcp-virtual-copy-${randomUUID()}.json`));
  const opened = await openLiveSession();
  let session = opened.session;
  const { marker, catalogPath } = opened;
  const tool = async (name, args) => (await session.toolOrThrow(name, args)).data;
  const metadata = (id) => tool("get_photo_metadata", { photo_id: id, sections: ["developSettings"] });
  const readMasters = async (ids) => {
    const rows = [];
    for (const id of ids) {
      const photo = await metadata(id);
      assert.equal(photo.isVirtualCopy, false, `fixture ${id} must be a master`);
      rows.push({ id: String(id), path: photo.path, settings: photo.developSettings,
        storedSettings: storedSettingsRow(catalogPath, id), copyIds: copyIds(photo) });
    }
    return rows;
  };
  const writeReceipt = (receipt) => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  let receipt;
  try {
    if (mode === "replay") {
      receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      assert.equal(receipt.version, 1, "unsupported receipt version");
      assert.equal(receipt.catalogPath, catalogPath, "receipt belongs to another throwaway catalog");
    } else {
      const sourceIds = [requireFixtureId(marker, "wide_plain"), requireFixtureId(marker, "ramp256")].map(String);
      const selection = await tool("get_selected_photos", {});
      const before = await readMasters(sourceIds);
      const name = `LRMCP retry ${randomUUID()}`;
      const prior = await tool("create_virtual_copies", { photo_ids: sourceIds, copy_name: name });
      assert.equal(prior.status, "complete", JSON.stringify(prior));
      assert.equal(prior.created, sourceIds.length);
      const baseline = await readMasters(sourceIds);
      for (const master of baseline) {
        const previous = before.find((row) => row.id === master.id);
        const owned = prior.copies.filter((copy) => copy.master_id === master.id).map((copy) => copy.copy_id);
        assertCopyIds(master.copyIds, [...previous.copyIds, ...owned], "same-name setup touched an unrelated copy");
      }
      const request = { photo_ids: [baseline[0].path, sourceIds[1]], copy_name: name, operation_id: `live-vc-${randomUUID()}` };
      await tool("create_virtual_copies", request);
      const afterDiscard = await readMasters(sourceIds);
      const createdCopyIds = [];
      for (const master of afterDiscard) {
        const previous = baseline.find((row) => row.id === master.id);
        const added = master.copyIds.filter((id) => !previous.copyIds.includes(id));
        assert.equal(added.length, 1, `first named attempt must add exactly one copy of master ${master.id}`);
        createdCopyIds.push(...added);
      }
      receipt = { version: 1, catalogPath, request, selection, before, baseline,
        priorCopyIds: prior.copies.map((copy) => copy.copy_id), createdCopyIds: sorted(createdCopyIds) };
      writeReceipt(receipt);
      if (mode === "prepare") {
        console.log(JSON.stringify({ phase: "prepared", receiptPath, operationId: request.operation_id,
          discardedFirstResult: true, createdCopyIds: receipt.createdCopyIds,
          masterCopyCounts: afterDiscard.map((master) => ({ masterId: master.id, count: master.copyIds.length })) }));
        return receipt;
      }
      await session.stop();
      assert.equal(requireThrowawayCatalog(), catalogPath, "catalog changed before reconnect");
      session = await new McpSession().start();
    }

    const sourceIds = receipt.baseline.map((master) => master.id);
    const replayed = await tool("create_virtual_copies", receipt.request);
    assert.equal(replayed.status, "complete", JSON.stringify(replayed));
    assert.equal(replayed.created, sourceIds.length);
    assertCopyIds(replayed.copies.map((copy) => copy.copy_id), receipt.createdCopyIds, "retry returned different copy identities");
    const afterReplay = await readMasters(sourceIds);
    for (const master of afterReplay) {
      const initial = receipt.baseline.find((row) => row.id === master.id);
      const owned = replayed.copies.filter((copy) => copy.master_id === master.id).map((copy) => copy.copy_id);
      const intentional = (receipt.intentionalCopies ?? []).filter((copy) => copy.master_id === master.id).map((copy) => copy.copy_id);
      assertCopyIds(master.copyIds, [...initial.copyIds, ...owned, ...intentional], "replay added or removed a copy");
    }
    const repeated = await tool("create_virtual_copies", receipt.request);
    assert.deepEqual(repeated.copies, replayed.copies, "second replay changed the mappings");
    const conflict = await tool("create_virtual_copies", { ...receipt.request, copy_name: receipt.request.copy_name + " changed" });
    assert.equal(conflict.status, "conflict", JSON.stringify(conflict));
    assert.equal(conflict.failure.code, "operation_conflict");
    assert.deepEqual(conflict.copies, replayed.copies, "conflict lost known mappings");
    const intentional = await tool("create_virtual_copies", { ...receipt.request,
      operation_id: receipt.request.operation_id + "-intentional" });
    assert.equal(intentional.status, "complete", JSON.stringify(intentional));
    assert.equal(intentional.created, sourceIds.length);
    assert.ok(intentional.copies.every((copy) => !receipt.createdCopyIds.includes(copy.copy_id)), "new operation reused an old copy");
    receipt.intentionalCopies = intentional.copies;
    writeReceipt(receipt);
    const final = await readMasters(sourceIds);
    const allCreated = [...replayed.copies, ...intentional.copies];
    for (const master of final) {
      const baseline = receipt.baseline.find((row) => row.id === master.id);
      const before = receipt.before.find((row) => row.id === master.id);
      assertCopyIds(master.copyIds, [...baseline.copyIds, ...allCreated.filter((copy) => copy.master_id === master.id).map((copy) => copy.copy_id)],
        "final catalog count contains an unexpected copy or a missing prior copy");
      assert.deepEqual(master.settings, before.settings, `master ${master.id} Develop settings changed`);
      assert.deepEqual(master.storedSettings, before.storedSettings, `master ${master.id} stored Develop settings changed`);
    }
    for (const copyId of [...receipt.priorCopyIds, ...allCreated.map((copy) => copy.copy_id)]) {
      const photo = await metadata(copyId);
      assert.equal(photo.isVirtualCopy, true, `${copyId} must remain a virtual copy`);
      assert.ok(sourceIds.includes(String(photo.virtualCopy.masterPhotoId)), `${copyId} points to an unexpected master`);
    }
    if (mode === "run") {
      assert.deepEqual(await tool("get_selected_photos", {}), receipt.selection, "creation failed to restore selection");
    }
    console.log(JSON.stringify({ phase: "verified", receiptPath, operationId: receipt.request.operation_id,
      discardedFirstResult: true, freshMcpSession: true, replayedMappings: replayed.copies,
      intentionalMappings: intentional.copies, untouchedSameNameCopyIds: receipt.priorCopyIds,
      masterSettingsUnchanged: true, storedMasterSettingsUnchanged: true,
      masterCopyCounts: final.map((master) => ({ masterId: master.id, baseline: receipt.baseline.find((row) => row.id === master.id).copyIds.length,
        final: master.copyIds.length })) }));
    return receipt;
  } finally {
    await session.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, receiptPath] = process.argv.slice(2);
  assert.ok(!flag || ["--prepare", "--replay"].includes(flag), "usage: virtual-copy-retry.mjs [--prepare|--replay /absolute/receipt.json]");
  if (flag) assert.ok(receiptPath && path.isAbsolute(receiptPath), "receipt path must be absolute");
  await run({ mode: flag?.slice(2) ?? "run", receiptPath });
}
