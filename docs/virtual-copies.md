# Retry virtual-copy creation

Supply an `operation_id` when a timeout, disconnect, or restart may require a retry.
Keep the same request for every retry.

```js
const request = {
  photo_ids: ['914', '/photos/portrait.nef'],
  copy_name: 'Experiment',
  operation_id: 'portrait-session-a',
};
await callTool('create_virtual_copies', request);
// A lost response does not require a new identity.
await callTool('create_virtual_copies', request);
```

An operation belongs to the active catalog. Its record remains in that catalog
without expiry, across bridge reconnect, plug-in reload, and normal Lightroom
restart. Use a nonblank ID of at most 128 UTF-8 bytes. A new ID intentionally
creates another set of copies, even when `copy_name` is unchanged. Omitting the
ID preserves additive behavior, so every call can create more copies.

The first call freezes the exact ordered selectors, their resolved sources,
missing inputs, source and master IDs and UUIDs, and the optional copy name.
Numeric selectors normalize to strings. Reordering selectors, adding duplicates,
changing an alias or path, or changing the copy name returns `operation_conflict`
before photo lookup. An omitted copy name differs from a supplied name. A retry
uses the frozen sources even if a path now resolves to a new virtual copy.

Inspect `status` and `retryable` even when the MCP call itself succeeds.

| Field | Meaning |
| --- | --- |
| `status` | `complete`, `partial`, `uncertain`, `conflict`, or `blocked`. |
| `retryable` | True only for a named operation with safely pending work. Retry the identical request. Unnamed calls always return false. |
| `created` | Total verified mappings known for this operation, including mappings returned on earlier calls. |
| `copies` | Verified `photo_id`, `master_id`, and `copy_id` mappings. Edit through `copy_id`. |
| `inputs` | Every ordered input, including aliases and missing selectors, with its frozen source, master, state, and known returned copy IDs. |
| `missing` | Selectors that were missing on the first call. Later imports do not change them. |
| `observed_copies` | Every known ID returned by the SDK, with `expected_master_id` and a `verified` flag. A metadata failure can leave an ID unverified. |
| `failure` | An operation error with `code`, `message`, and an optional source `photo_id`. Known mappings remain available. |
| `restoration_error` | A separate selection or view-source restoration error. A completed creation can still have this field. |

Selection failures before creation leave safely pending work. A retry returns
recorded mappings and creates only the pending sources. An SDK exception or an
unfinished attempt returns `uncertain` and blocks all further creation for the
operation. Lightroom may have created a copy without returning its ID. The tool
never guesses ownership from names or sibling copies, adopts unrelated copies,
or deletes copies. It never replaces a recorded copy that a user later deletes.

Each attempt is recorded before the SDK call, and returned mappings are
checkpointed afterwards. If a checkpoint fails, the call returns `blocked` and
keeps known IDs in the running plug-in. Same-process retries preserve those IDs
and cannot create more. After a plug-in restart, only the last durable record is
available. A durable unfinished attempt blocks creation even if its returned IDs
were lost with the failed checkpoint.

Malformed or unsupported records fail closed. Restoring an older catalog or
erasing operation history also restores or erases its retry history. Sudden
power-loss durability depends on Lightroom's catalog transactions and is not an
additional guarantee of this tool.

## Verify in a throwaway catalog

`node tests/e2e/live/virtual-copy-retry.mjs` creates only test-owned copies and
leaves them in the guarded throwaway catalog. It discards the first operation
result, starts a new MCP session, and checks actual catalog IDs and counts.

For a native Lightroom restart between calls, run
`node tests/e2e/live/virtual-copy-retry.mjs --prepare /absolute/path/receipt.json`,
restart Lightroom normally, and then run
`node tests/e2e/live/virtual-copy-retry.mjs --replay /absolute/path/receipt.json`.
The receipt records the operation request, owned copy IDs, baseline copy IDs,
and master settings. Replay verifies those copies, their counts, and unchanged
master settings without creating replacements.
