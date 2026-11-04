# Preview limit verification

This change keeps single, batch, and region previews within 2000 pixels on the
longest edge and 3.5 MiB per JPEG. Batch JPEGs together stay within 8 MiB.
The source remains Lightroom's rendered JPEG, including its develop edits.

## Before and after

Two automated regressions use a real 2400×1600 JPEG. Before the change, the
single-image assertion reports `Expected: <= 2000; Received: 2400`. A request
for a feasible 600×400 region reports an error. Both pass after the change.

The server now accepts one source at a time, with a 10 MiB encoded source cap
and a 32-megapixel decode cap. The codec accounts for at most 512 MiB of decode
allocations. This is not a process RSS guarantee. A worker validates and decodes
the JPEG, crops before resizing, and encodes within the output budget. A compliant
full-frame JPEG retains its original bytes. One 20-second deadline covers source
acquisition and worker processing. The parent can terminate the worker.

## Lightroom 15.6 fixture run

The November 3, 2026 run used a dedicated marked throwaway catalog and the
repository's CC0 Sony ILCE-7M3 samples. The 12-bit RAW had AI Denoise set to 50
before the preview checks. The normal 14-bit RAW remained unedited.

| Captured native source | Dimensions | JPEG bytes |
| --- | --- | ---: |
| Normal RAW, `_DSC0009.ARW` | 6000×4000 | 8,812,776 |
| Denoised RAW, `_DSC0010.ARW` | 6000×4000 | 9,280,267 |

Both fixtures naturally returned smaller cached tiers for smaller minimum
requests. They did not naturally reproduce the original catalog's persistent
oversized cache. A test-only Lua hook therefore replayed each captured full-size
JPEG after every thumbnail callback. It did not change the photo or its settings.
The hook and isolated test ports were present only in the temporary test bundle.

The old handler rejected the replayed denoised source with
`Preview is 9280267 bytes, over the 3670016 byte limit even at size 64`.
The candidate produced these actual decoded outputs for the same repeated source.

| Controlled persistent-cache result | Dimensions | JPEG bytes |
| --- | --- | ---: |
| Normal RAW, each of sizes 2048, 512, and 64 | 2000×1333 | 1,508,196 |
| Denoised RAW, each of sizes 2048, 512, and 64 | 2000×1333 | 1,522,125 |
| Normal RAW, center quarter region | 1500×1000 | 834,552 |
| Denoised RAW, center quarter region | 1500×1000 | 884,153 |

A mixed batch contained a duplicate ID, a missing path, and both RAW fixtures.
It returned three images totaling 4,538,517 bytes. The missing row had an error
and no image index. Successful rows retained their input order and 1-based image
indexes. A 20-photo repeated-source run returned six images totaling 8,247,571
bytes and 14 remaining IDs at the deadline. No returned image exceeded its limits.

Native-cache checks also passed. At size 2048, the normal and denoised RAWs
returned 2000×1333 JPEGs of 1,401,391 and 1,408,694 bytes. Smaller compliant
cache entries retained their dimensions and bytes. The mixed native-cache batch
totaled 551,587 bytes.

Develop metadata matched before and after all preview requests. The complete
stored develop-settings rows and develop-history rows also matched exactly for
both RAWs. These comparisons began after Denoise setup.

## Regression and artifact checks

The standard CI coverage command passed 27 suites and 946 tests with the existing
coverage thresholds. Type checks, ESLint, and the build passed. Lua verification
passed 1,454 specs and lint. The live-kit unit tests passed 57 checks, and the
bundled skill tests passed 20 checks. Additional error-path and cancellation
checks retain coverage above the existing Windows threshold without lowering it.

`server/tests/preview-limits.test.ts` drives the public tool handler through
oversized, malformed, missing, duplicate, canceled, deadline, and batch-budget
cases. `preview-jpeg.test.ts` checks real codec output, source limits, progressive
JPEGs, scan validation, pixel bounds, and byte-budget reduction. Lua specs verify
source-mode bounds while preserving existing internal statistics and duplicate
consumers.

Independent review found that `jpeg-js` could accept a JPEG without an image
scan, even with tolerant decoding disabled. The worker now checks the frame and
requires positive decoded dimensions. Apple ImageIO rejected the malformed
fixture and decoded the delivered full-frame and region artifacts successfully.

The final extracted MCPB and standalone macOS arm64 executable both passed
full-frame and region calls through Lightroom using the captured denoised
source. Apple ImageIO independently decoded their output. An isolated compiled
program using the production preview handler also passed six alternating
full-frame and region calls with its source directory unavailable.

Some packaged live attempts returned explicit 20-second deadline errors.
Instrumentation located a subsequent timeout in source acquisition, before the
worker started. Both final packages later passed. The cause of every timeout
was not established. Connection liveness and preview freshness remain outside
this change's scope.

The original installed bundle was restored byte-for-byte. Lightroom reopened
the original catalog in its prior Develop module. Both default ports
were listening, and `list_collections` answered through MCP. The candidate was not left active.

## Rerun

Run the standard checks from the repository root and `server` directory as
documented in `AGENTS.md`. With exclusive Lightroom ownership and a marked
throwaway catalog, run:

```sh
node tests/e2e/live/preview-limits.mjs NORMAL_RAW_ID DENOISED_RAW_ID
```

The script reads previews and develop metadata. It does not enable Denoise or
write photo edits. Prepare a disposable denoised fixture before running it.
The persistent-cache replay is additional controlled fault injection, not a
claim that the ordinary fixture script forces Lightroom to reproduce that cache
state.
