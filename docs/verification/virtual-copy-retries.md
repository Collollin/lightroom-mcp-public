# Virtual-copy retry verification

Verified on November 3, 2026 with Lightroom Classic 15.6 on macOS, using a new
marked throwaway catalog and the generated `wide_plain` and `ramp256` fixtures.
No creation test ran in the original catalog.

## Native correction

The first named operation returned `blocked`, `created: 0`, and
`checkpoint_failed` at the readback inside `withPrivateWriteAccessDo`.
Removing only that in-callback readback let the same operation complete with
the same saved copy. The raw-preimage comparison still runs inside the write gate, and
the saved value is still verified after the gate returns, before SDK creation.

The deferred-visibility regression failed before the correction with actual
`blocked`, expected `complete`. It then passed, including replay after module
reload. The final handler used for native verification has SHA-256
`457193af468516008efbbfda54728644eec8d6834b29e3e9604d5df8cbbf631a`.

## Retry results

The guarded `tests/e2e/live/virtual-copy-retry.mjs` prepare phase discarded the
first named response and recorded the actual catalog IDs. Lightroom then quit
normally and reopened the same catalog. The replay crossed a full process
restart, a plug-in reload, and a socket reconnect.

The named operation produced these results. Symbolic labels below replace
run-specific catalog IDs consistently.

| Master | Same-name prior copy | Frozen source | Replayed copy | New-operation copy |
| --- | --- | --- | --- | --- |
| `master-A`, wide_plain | `prior-copy-A` | `prior-copy-A` | `replayed-copy-A` | `new-copy-A` |
| `master-B`, ramp256 | `prior-copy-B` | `master-B` | `replayed-copy-B` | `new-copy-B` |

The first input was a file path. It stayed bound to source `prior-copy-A` on replay even
after newer copies shared that path. A new operation with the same copy name
created `new-copy-A` and `new-copy-B` instead of adopting prior copies. Reusing the original
operation ID with a changed copy name returned `operation_conflict` and retained
the recorded mappings.

| Master | Copies before named call | After named call and restart replay | After intentional new operation |
| --- | ---: | ---: | ---: |
| `master-A` | 4 | 5 | 6 |
| `master-B` | 3 | 4 | 5 |

The baseline includes copies from the earlier setup and checkpoint probes.
Every baseline ID remained present. Repeated replay added no copies. Both
masters retained all 29 returned Develop-setting fields and their nonempty
stored Develop rows, compared with the first baseline before the probes.
The selected photo also matched that baseline.

A separate single-photo operation returned the same copy before and after a
normal restart. The master retained all three recorded copy IDs across replay.

## Isolation and restoration

The existing default-port broker rejected the new `operation_id` argument using
its older tool schema. The candidate therefore ran on isolated ports `59783`
and `59784`. Only the two default-port constants in `PluginInfoProvider.lua`
differed from the source bundle. The final handler was byte-identical to source.
The existing bridge process was not terminated, and port preferences were not
changed.

The native Undo menu exposed `Undo Select`, then no further Undo action.
Redo restored that selection. Subsequent replay preserved the same IDs, counts,
and master settings. This run does not claim global Undo support or a live
copy-deletion recovery test. Those deletion/refusal cases and injected partial
SDK failures remain covered by automated tests.

The original installed bundle was restored and compared byte-for-byte with its
backup. The original catalog, selected photo, and Develop module
were restored. Both default ports listened, and MCP answered successfully.
The candidate was not left active.

## Source checks

After the correction, type checking, ESLint, build, Lua lint, 903 Jest tests,
and 1,484 Lua specs passed. Independent review found no remaining issue in the
correction. The unchanged skill and live-kit tests previously passed 20 and 58
tests respectively.

Historical local evidence included failed and corrected checkpoint responses,
before-and-after metadata, restart verification, prepare/replay results, and
restoration confirmation. Those machine records are not part of this repository.