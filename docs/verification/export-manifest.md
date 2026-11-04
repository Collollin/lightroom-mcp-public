# Export manifest verification

Verified on November 3, 2026 with Lightroom Classic 15.6 and Node 26.13.0 on macOS.
The live run used the marked throwaway catalog and the guarded
`tests/e2e/live/export-manifest.mjs` checker. The candidate server owned the bridge.
A temporary plug-in copy changed only the default port constants to 59131/59132;
the export handler matched the source tested in this PR.

## Live results

The checker compared every completed result with the filesystem and compared
raster dimensions with `sips` immediately after each export response.

| Format | Primary file | Bytes | Stored dimensions |
| --- | --- | ---: | --- |
| JPEG | wide_plain.jpg | 22,852 | 256 × 154 |
| JPEG | orient_6.jpg | 24,207 | 215 × 256 |
| PNG | wide_plain.png | 114,337 | 256 × 154 |
| PNG | orient_6.png | 11,201 | 215 × 256 |
| TIFF | wide_plain.tif | 252,130 | 256 × 154 |
| TIFF | orient_6.tif | 347,644 | 215 × 256 |
| Original | wide_plain.jpg | 97,801 | Explicitly unavailable |
| Original | arw_14bit.arw | 25,639,680 | Explicitly unavailable |

The orientation fixture rendered at 215 × 256. The manifest reports those
actual output dimensions rather than the requested 256 × 256 bounds.

Two owned imports with the same basename, an owned virtual copy, and a repeated
input exercised all three policies. Rename produced four distinct files, then
four more distinct files on a second call. Skip produced one completed result
and three skips, then four skips on the second call. Existing bytes were
unchanged. Overwrite produced one retained result and three `output_superseded`
failures pointing to the final input. Input ordinals, resolved photo IDs and
aggregate counts agreed throughout. Mixed and all-missing requests also passed.

## Correction found by the live run

Lightroom omits collided photos from the rendition iterator under `skip`.
The initial handler therefore returned three `rendition_missing` failures, and
the live assertion failed with `0 !== 3` for skipped results. The fix classifies
an empty iterator as skipped only under that policy. A separate live probe with
an owned original temporarily moved offline still returned `render_failed`
under `skip`; the source was restored afterward.

The focused regression failed before the fix and passed afterward. The full
live matrix then passed, with 21 recorded tool answers including 15 exports.
Final local checks passed type checking, ESLint, build, 923 Jest tests, Lua lint,
and 1,457 Lua tests. The earlier unchanged skill and live-helper checks passed
20 and 57 tests respectively. Independent review found no actionable issue in
the correction.

## Limits and restoration

Header dimensions do not prove full pixel integrity. Original sidecars are not
enumerated, and checksums are not computed. Failed-overwrite invalidation and
cancellation have automated coverage; this run did not induce those live cases.
Files are verified at response time and can change after a later export.

The original installed bundle was restored and matched its backup. The original
catalog, Develop module, and selected photo were restored. The default ports
answered `list_collections`, and the temporary ports were closed. Owned fixtures and outputs remain only in the disposable
catalog. No merge or permanent candidate activation occurred.

Historical local evidence included raw manifests, before-and-after test logs,
review reports, and restoration confirmation. Those machine records are not
part of this repository. The historical CodeQL result upload failed; that
configuration failure is not a passing security check for this public branch.