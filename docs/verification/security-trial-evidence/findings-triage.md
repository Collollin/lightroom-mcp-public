This triage tests what free scanners add alongside existing checks in the scanner trial. It makes no CodeQL replacement or parity claim.

Measured evidence comes from the supplied scanner JSON and the historical export-feature source snapshot.
Source locations below are relative to that repository snapshot. The recorded
scanner results were not rerun against the clean public commits.
Classification is static review inference unless explicitly marked measured. No application, live test, or exploit ran.

Semgrep emitted 12 findings. Two security findings merit contextual audit. Ten findings are false positives or irrelevant to this runtime. This review establishes no exploitable defect.

| Finding group | Locations | Classification and source evidence |
| --- | --- | --- |
| `spawn-shell-true`, 1 | `scripts/build-mcpb.mjs:86-90` | Contextual audit. Shell mode applies only on Windows. The pack command has fixed executable and command arguments, with staging and output paths derived from the script directory. No request input or CLI argument feeds this call. Shell interpretation of an unusual checkout path remains a possible local build concern. No injection was demonstrated. |
| `mcp-ssrf-typescript`, 1 | `server/src/create-server.ts:30` | False positive. The request name feeds `getSkillPrompt`. `server/src/skill-prompt.ts:10-18` selects local prompt content and returns messages. It makes no HTTP request. The rule's generic callable sink treats any function as axios. |
| `ajv-allerrors-true`, 1 | `server/src/validate-args.ts:19` | Contextual audit. The option is enabled and client arguments reach validation at `server/src/tool-handler.ts:83`. Schemas compile from local tool contracts at `validate-args.ts:21-34`. Contracts include array, object, and string bounds. Large invalid input and error allocation require separate measurement before calling this a denial of service bug. |
| `missing-template-string-indicator`, 2 | `server/tests/list-tools-handler.test.ts:595`; `tests/e2e/live/lib/ax.mjs:57-99` | False positives. The first builds a regular expression with a literal escaped brace. The second embeds AppleScript with literal empty-list braces. Existing interpolation is intentional in both. |
| `no-stringify-keys`, 3 | `server/tests/tool-list-size.test.ts:77`; `tests/e2e/live/batch-preview.mjs:23`; `tests/e2e/live/remove-from-catalog.mjs:33` | False positives. Indexed values occur in object construction or JSON logging and command argument serialization. The size test uses serialized length. No serialized string becomes an object key at these sites. |
| `no-replaceall`, 4 | `tests/e2e/live/lib/ax.mjs:27`, twice; `tests/e2e/live/lib/catalog-db.mjs:36`; `tests/e2e/live/raw-jpeg-pairs.mjs:33` | Runtime mismatch. The rule warns about older browsers, while these are Node live-test scripts and the project declares Node >=20 in `server/package.json`. These uses do not establish a compatibility bug. |

Measured parser limits include two `PartialParsing` records at `.github/workflows/release.yml:178` in the repository scan. They concern the same location. A completed scan does not establish complete parsing.

Measured historical fixture evidence supports narrow same-file command-injection detection. The cross-file command flow and the unsafe `schema.parse` case were missed by the intended command rule. A different SSRF rule firing on a generic function call does not count as successful command-flow detection.
The bad Action fixture triggered `run-shell-injection` at `action-bad.yml:7`, alongside two Bash `PartialParsing` records at that line. Those errors limit the Action coverage claim.

Measured OSV output contains 432 package entries and nine affected package versions. The nine versions produce 19 package-advisory associations and 14 unique GHSA advisories. Their 14 CVE aliases do not add another 14 vulnerabilities.
The source is `server/package-lock.json`, lockfile version 3. All nine versions are transitive. None is a direct dependency in `server/package.json`.

| Package version | Exposure from lockfile | Dependency route | Advisory count for this version |
| --- | --- | --- | --- |
| `brace-expansion@2.1.4` | Development only | Nested under `test-exclude`, through nested `glob` and `minimatch` | 3 |
| `brace-expansion@5.0.9` | Development only | Top-level `minimatch` | 3 |
| `deepmerge@4.3.1` | Development only | `jest-config` | 1 |
| `fast-uri@3.1.6` | Production dependency | Direct production dependency `ajv` | 7 |
| `glob@10.5.0` | Development only | Nested under `test-exclude` | 1 |
| `glob@13.0.6` | Development only | Jest packages | 1 |
| `minimatch@9.0.9` | Development only | Nested under `test-exclude` and `glob` | 1 |
| `minimatch@10.2.6` | Development only | ESLint, TypeScript ESLint, Jest's glob, and test-exclude | 1 |
| `zod@4.4.3` | Production dependency, also shared with development dependencies | `@modelcontextprotocol/server` and its core dependency, also the development client | 1 |

The production designation describes installation reachability from lockfile metadata. It does not prove vulnerable code executes or that an advisory is exploitable here. Development dependencies also require reachability analysis before assigning impact.

Measured advisory identifiers are grouped below. Repeated package versions share the same advisory sets.

- `brace-expansion` has `GHSA-6j4f-fj2g-mc7p`, `GHSA-q2hr-2g5m-vwhr`, and `GHSA-qhr7-859c-m2p7`.
- `deepmerge` has `GHSA-gcqx-w48m-w2h4`.
- `fast-uri` has `GHSA-333x-w4r6-6crp`, `GHSA-58mr-gqgx-xq4g`, `GHSA-hrr3-gc8f-f4qj`, `GHSA-qw65-cvwx-89v3`, `GHSA-w74x-v6f9-j3xg`, `GHSA-wjr9-j795-jxcr`, and `GHSA-xhq7-xmqj-769h`.
- Both `glob` versions have `GHSA-3g3m-2fjr-6pw4`.
- Both `minimatch` versions have `GHSA-g3hv-75wg-m249`.
- `zod` has `GHSA-mrhx-c7xc-m3w5`.

The supplied TruffleHog snapshot result is zero findings. This triage did not reread its raw data or independently rerun it. Zero findings does not establish absence of secrets.

The historical review compared findings with actual source structure and
package observations with actual lockfile metadata. Native reports remain
outside this repository. Rule behavior was checked against the pinned rule
archive in `security/trial-pins.json`.