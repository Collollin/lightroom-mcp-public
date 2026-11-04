import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCopyIds } from "../virtual-copy-retry.mjs";

test("copy verification compares catalog identities without depending on enumeration order", () => {
  assertCopyIds([103, "101"], ["101", "103"], "same copies");
  assert.throws(() => assertCopyIds([101, 102], [101, 103], "wrong identity"), /wrong identity/);
  assert.throws(() => assertCopyIds([101, 101], [101], "unexpected duplicate"), /unexpected duplicate/);
});
