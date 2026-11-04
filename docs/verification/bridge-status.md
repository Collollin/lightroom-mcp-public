# Bridge status verification

Verified on November 3, 2026 against Lightroom Classic 15.6.0.202609251514 on macOS. The candidate reports server version 0.26.0 and loaded plug-in version 0.26.0.0.

## Source checks

The required TypeScript check, ESLint, build, Jest, Selene and Lua specs passed. The full Lua suite also passed under both Lua 5.1 and Lua 5.5. Jest covered 928 tests and Lua covered 1,454 tests. Independent correctness review found no actionable findings and reran 68 focused status and bridge tests. The scoped comment review found no added code comments.

Regression coverage includes missing Lightroom, half-connected sockets, responsive and busy replies, a silent peer, unavailable or old owners, legacy plug-ins, malformed frames and metadata, timeout cleanup, cancellation, late replies, ownership changes, response-only reconnects, read-only listing and argument validation. Lua specs verify independent metadata getters and status during an active business handler. The fixture uses reentrant dispatch so it also runs on Lua versions whose built-in `pcall` cannot yield.

## Live checks

All candidate checks used a marked throwaway catalog. The catalog guard
passed before the run and after the fault-injection relaunch.

An existing bridge retained the normal ports. The test bundle temporarily returned ports 58873 and 58874 from `readPortPrefs`, and the candidate servers used the matching environment variables. No other bridge was stopped. The tested status implementation otherwise matched the source candidate.

| Case | Actual result |
| --- | --- |
| Healthy leader and follower | Both returned successful structured `responsive` data with separate local and owner identities, loaded plug-in and Lightroom versions, the correct catalog path, and sorted registered actions. |
| Concurrent read | During one four-photo preview request, eight follower status calls returned `busy` with one active business operation. The next status returned `responsive` with zero active operations. The preview succeeded. |
| Lightroom closed normally | Leader and follower both returned successful structured `disconnected` data with unavailable runtime metadata. |
| Delayed plug-in reply | A temporary installed-only test variant added `LrTasks.sleep(4)` before the normal status body. Leader and follower both returned successful structured `unresponsive` data in 1,503 ms, with probe outcome `timeout` and unavailable runtime metadata. |
| State preservation | Selected-photo data matched before and after the concurrent-read check. All four stored Develop-setting rows had the same SHA-256 before and after the run. |

The Develop-setting comparison selected `(image, text)` from `Adobe_imageDevelopSettings` ordered by image. Both snapshots had four rows and the same SHA-256 digest.

The live `unresponsive` result is controlled fault-injection evidence. It does not diagnose the cause of an uncontrolled Lightroom stall. Missing-owner and malformed-reply `unknown` states were verified in automated tests. Timer deadlines assume the local Node event loop can run.

## Restoration

Lightroom was closed normally before bundle restoration. The original installed bundle was restored from its backup outside the temporary directory and passed a byte-for-byte comparison. The original catalog and Develop module were restored. Plug-in Manager was closed, and `node tests/e2e/mcp-runner.mjs tool list_collections '{"limit":1}'` succeeded on the original ports. The temporary candidate servers were stopped.

Historical local evidence included full replies, a live summary, Develop-setting
hashes, bundle backup and restoration records, and the fault-injection method.
Those machine records are not part of this repository.