# Displayed crop verification

This change adds `set_photo_crop` for normalized bounds in the full uncropped displayed image, or the largest crop of a displayed pixel aspect ratio. An aspect anchor aligns the available space. The operation replaces an existing crop and writes only its four edges.

## Supported geometry and readback

Lightroom Classic 15.6 reports numeric `dimensions` and `croppedDimensions` in displayed orientation. The implementation does not swap them again. Fresh synthetic JPEGs report uncropped edges `0, 0, 1, 1`, `CropAngle=0`, perspective controls at zero except `PerspectiveScale=100`, and disabled lens-profile/manual-distortion controls. The operation requires those controls to be readable and neutral, and refuses unknown perspective fields.

A live landscape 2:1 request saved `CropBottom=0.833333` for an intended `5/6`, with the correct 1000 by 500 dimensions. Crop comparisons allow `1e-6` normalized-coordinate precision and dimension comparisons allow one pixel per axis. Responses return the observed edges and metadata dimensions. They identify verification as `settings_and_metadata`; they do not claim to have rendered a new image.

Nonzero straighten and active perspective or geometric lens correction are unsupported. The existing raw SDK setter is unchanged. A failed post-write check returns an explicit unverified outcome without a rollback that could overwrite a subsequent edit.

## Reproduce

Use the live kit's marked throwaway catalog and the eight generated EXIF fixtures. Back up the installed bundle outside the temporary directory and restore it after testing. Confirm the actual installed path in Plug-in Manager; this run used Lightroom's `Modules` directory rather than the kit's default `Plugins` directory.

```sh
node tests/e2e/live/crops.mjs /absolute/path/to/crop-evidence
```

Use a new or empty output directory so stale files cannot satisfy the checks. The script exports full-resolution JPEGs, decodes their dimensions, and compares their pixels with independently oriented original fixtures. Wrong orientation, position, and dimensions must fail the same acceptance criterion. It also checks repeated requests, an existing crop, invalid bounds, nonzero straighten, and preservation of full saved Develop settings with a seeded nonempty mask. Test edits are restored in `finally`.

## November 3, 2026 run

The instrumented framing and view checks passed on Lightroom Classic 15.6 on macOS. A temporary read-only metadata observer recorded module, source, active photo, selection, and full Develop settings. Successful crops preserved the view and unrelated settings. Invalid bounds and straighten refusal preserved all settings. The checks covered Develop with active and non-active targets, Library, and an empty selection. The observer is not part of the source or public tool contract.

| Case | Decoded export dimensions |
| --- | --- |
| Asymmetric displayed bounds, EXIF 1 through 4 | 700 by 300 |
| Asymmetric displayed bounds, EXIF 5 through 8 | 420 by 500 |
| Portrait 4:5, EXIF 6 | 600 by 750 |
| Landscape 2:1, EXIF 1 | 1000 by 500 |
| One-pixel strip | 1 by 600 |

The final run against the exact uninstrumented bundle passed all ten rendered cases. The largest normalized mean RGB absolute error was below 0.000037, below the 0.02 acceptance threshold. Wrong-orientation and wrong-position controls exceeded that threshold. A populated output directory is refused before edits.

Saved Develop rows use an `s = { ... }` assignment wrapper. The original test passed that wrapper to a table parser and produced an invalid value that compared as an empty object. That earlier preservation result was discarded. The corrected parser requires a nonempty object, and the test requires the seeded exposure and mask ID before comparing state. The corrected full run passed, including unrelated saved settings and the seeded nonempty mask. The parser targets Lightroom's serialized literal-table format, not arbitrary Lua.

The original plug-in was restored byte-for-byte while Lightroom was closed. The original catalog, Develop module, and captured photo selection were verified afterwards, and MCP answered on the original ports. Reopening the catalog alone did not reliably restore the selection; the captured selection was restored explicitly.

Local checks passed with 912 Jest tests, 1,474 Lua specs, 61 live-kit tests, and 20 skill tests, plus type checking, lint and build. Independent reviews identified a one-pixel floating-point boundary defect. Its reproducer and regression pass. A later independent review of the live-driven fixes found no verified defects.

Historical CodeQL analysis completed, but result upload failed. That run is not a passing security check for this public branch.
