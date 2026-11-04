# Free scanner trial

This trial adds repeatable free Semgrep CE, OSV-Scanner and TruffleHog evidence beside the existing checks. Existing build, lint, tests and CodeQL remain separate requirements. Findings are scanner observations that need review. A clean result does not establish equivalent CodeQL coverage.

## Run the trial

Install the pinned tools outside the checkout, then run detector verification and a repository scan independently.

```sh
python3 scripts/security-trial-setup.py "$HOME/.cache/lightroom-mcp-security"
node --test tests/security-trial.test.mjs
node scripts/security-trial.mjs verify
node scripts/security-trial.mjs scan
```

Use `--tool semgrep`, `--tool osv` or `--tool trufflehog` for one engine. `--tools-dir /absolute/path` selects the setup directory. `--output /absolute/path` selects sanitized evidence storage. `--timeout 300000` sets a per-process deadline in milliseconds.

`scan --revision COMMIT` materializes that commit using `git archive`, including its export-attribute semantics. The default is `HEAD`. Tracked worktree edits and untracked files are excluded. CI scans its own checkout commit. Fixtures are generated separately in an owner-only temporary directory and are never installed or executed. The source snapshot is never sent to a hosted scanner. OSV sends public dependency names and versions to the OSV advisory service. Its advisory database changes independently of pinned tool versions.

Semgrep temporarily uses an empty `.semgrepignore` in the private snapshot to disable its built-in test and vendor exclusions. `--no-git-ignore` also disables Git ignore filtering. The report records this trial policy. The runner restores the original ignore file before another tool runs. Submitted source counts exclude a generated ignore file, and native scanned paths may include it. Requested JavaScript, TypeScript and YAML paths missing from the native scanned list make a run incomplete, even when another file was examined.

The setup supports macOS arm64 and Linux amd64. `security/trial-pins.json` owns tool versions, release asset checksums, the upstream rule commit and rule archive checksum. Semgrep has its own Python environment. Setup composes 228 rules from upstream JavaScript, TypeScript and GitHub Actions directories, preserving rule content and upstream metadata. Rule IDs include their relative upstream file path because upstream short IDs collide. The source archive contains upstream licensing information. No mutable registry, hosted account, Pro engine or credential verification is used.

## Read the evidence

`scan.json` and `verify.json` contain only constructed metadata, validated known paths, pinned rule IDs, advisory IDs, numeric detector IDs and counts. Their matching summary text files are safe to print. The runner captures raw stdout and stderr from process start in an owner-only temporary directory outside the checkout, then removes it. Raw messages, source snippets, redacted secrets, raw secrets, secret fingerprints and arbitrary metadata never enter published evidence. CI uploads only the four named sanitized files.

Repository process exits have these meanings.

| Exit | Status | Meaning |
| --- | --- | --- |
| 0 | clean | Native completion contract satisfied without findings. |
| 1 | findings | Completed with findings. |
| 2 | error | Invocation, configuration, version, report or unexpected exit failure. |
| 3 | incomplete | Timeout, interruption, analysis errors, skipped rules, missing completion or zero observed inputs. |

Findings remain visible when an analysis also reports errors. Semgrep partial parsing makes a repository run incomplete. An unavailable examination counter is `null`, never fabricated zero. `submittedFiles` counts materialized snapshot files and is distinct from observed Semgrep file or OSV package-version counts. TruffleHog does not expose an examined-file counter. Its valid empty JSONL is clean only with the expected native completion record. TruffleHog scans filesystem content in the snapshot. Git history is not scanned.

Fixture verification exits zero only if required positive, clean and failure cases match their declared behavior. Capability observations preserve their actual clean or findings state. They do not suppress repository findings. Cross-file warnings require semantic review because a sink warning alone does not prove cross-file flow.

## Observed fixture behavior

The implementation verification uses the pinned 228 upstream rules without fixture-specific tuning.

| Case | Measured observation | Boundary |
| --- | --- | --- |
| Same-file MCP argument to `exec` | Command injection finding. | Positive production-rule detector check. |
| Same-file argument to fixed `execFile` executable | Clean. | Safe argument control. |
| Cross-file unsafe helper and safe helper | Both receive the same upstream MCP SSRF warning. | These warnings do not distinguish unsafe command flow. The SSRF rule can match arbitrary calls. |
| Source-free helper sink | Clean. | No evidence of cross-file taint detection. |
| `z.string().parse(command)` followed by `exec` | Clean. | Observed command injection blind spot. Schema parsing alone does not make shell input safe. |
| Actions event interpolation in shell | Shell injection finding with partial parser errors. | Expected incomplete result remains visible. |
| Invalid Semgrep configuration | Error. | Must never become clean. |
| Lodash 4.17.20 lockfile | Includes GHSA-35jh-r3h4-6jhm. | Database-backed dependency positive. No package installation. |
| Lodash 4.18.1 lockfile | Clean at observation time. | Re-evaluated against current advisory data each run. |
| Generated non-live GitHub token format | Unverified detector finding. | Verification disabled. No provider check. |
| Ordinary text | Clean. | Secret detector control. |

## Coverage comparison and repository results

Semgrep measures selected JavaScript, TypeScript and Actions rules. This trial does not establish Lua analysis, interfile data flow or the full reliability and maintainability coverage of CodeQL's configured `security-and-quality` suite. OSV measures known dependency advisories. TruffleHog measures supported secret formats without verification. These are different evidence categories.

The historical local comparison targeted the export-feature source snapshot.
The trial branch itself is based on main and does not include export changes.
The recorded results below were not rerun against these clean public commits.
CI scans its own checkout revision. Those inputs and counts must not be conflated.

| Scanner | Selected-source observation | Outcome |
| --- | --- | --- |
| Semgrep CE 1.183.0 | 228 selected rules, 273 native scanned paths, 12 findings and two partial-parsing records | Incomplete, exit 3 from the runner. |
| OSV-Scanner 2.7.0 | 432 package-version entries, nine affected transitive versions, 19 package/advisory associations and 14 unique advisories | Findings. Advisory data is observed on November 3, 2026. |
| TruffleHog 3.99.8 | Zero findings in the tracked filesystem snapshot | Clean within that declared scope; examined-file count unavailable, history untested. |

Semgrep's scanned-path list includes generic-rule visits to Lua and other file types. It is not evidence of Lua-aware semantic analysis. All 122 requested JavaScript, TypeScript and YAML paths appeared in the native scanned list. The two parser records concern embedded Actions syntax at one location in `release.yml`; they prevent a complete result despite the findings.

Static triage grouped ten Semgrep findings as false positives or runtime mismatches and two as contextual audit items. The broad MCP SSRF rule flags a local prompt lookup as an HTTP request. Other noise concerns intentional literal braces, JSON serialization and `replaceAll` in supported Node runtimes. The Windows packaging script's shell mode and Ajv's `allErrors` option need contextual review; no exploit was demonstrated. This triage does not suppress their findings.

OSV's production dependency routes include `fast-uri@3.1.6` through Ajv and `zod@4.4.3` through the MCP SDK. The seven other affected package-version entries are development dependencies. Package/advisory matches establish affected versions, not runtime exploitability. Dependency upgrades and remediation are outside this trial.

| Capability | Evidence from this trial | Comparison limit |
| --- | --- | --- |
| Same-file command input | Selected Semgrep rule detects the unsafe fixture and leaves its argument-safe counterpart clean. | Narrow measured detector proof, not general completeness. |
| Cross-file command flow | Command rule misses the flow; the same unrelated SSRF warning appears on both unsafe and safe controls. | Does not replace CodeQL's documented global data-flow capability. These exact fixtures were not run through CodeQL. |
| Schema validation versus sanitization | String-type validation followed by shell execution is missed. | A rule-quality blind spot remains. |
| Actions workflows | Injection is detected, but other selected rules partially parse the expression. | Incomplete coverage is reported instead of suppressed. |
| Dependency advisories | Vulnerable and fixed lockfile fixtures differ as expected. | Complements source analysis; does not replace it. |
| Secret formats | A generated dummy GitHub token is detected without provider verification; benign text is clean. | No validity check or history scan. |
| CodeQL security-and-quality suite | Prior CodeQL logs record query execution, but result upload failed. | No usable CodeQL finding artifact or same-fixture run exists, so no direct parity or zero-findings claim. |

The current evidence does not justify replacing CodeQL. Keep this trial additive. A future adoption decision needs a reviewed rule profile, remediation/triage of dependency findings, explicit handling of parser gaps, and evidence for any claimed coverage equivalence. No paid feature, hosted account, merge or plug-in activation is part of this trial.

Primary references: [Semgrep CE CI](https://docs.semgrep.dev/deployment/oss-deployment), [Semgrep analysis limits](https://semgrep.dev/docs/writing-rules/glossary), [OSV source scanning](https://google.github.io/osv-scanner/usage/scan-source), [TruffleHog CLI](https://github.com/trufflesecurity/trufflehog), and [CodeQL query suites](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-query-suites).

## Review corrections and reproducibility

Independent review found that an empty OSV package object could be counted as a clean examined package. A red-first regression reproduced this result. The adapter now requires nonempty name, version and ecosystem fields before counting; seven boundary/process tests pass.

A real fresh setup exposed a Python interpreter symlink issue. Creating a venv through the shim recorded the wrong standard-library location and pip failed with a missing encodings module. Setup now invokes the resolved interpreter and refreshes a partial environment without clearing it. The original failed environment was repaired and all three pinned tool versions were read back.

Binary and rule archive checksums are pinned. Semgrep's own version is pinned, but its transitive Python dependency closure is not hash-locked. The trial does not claim a fully hermetic toolchain. Workflow SHA version comments are retained because Renovate uses them to track tag updates.

The saved [fixture observations](security-trial-evidence/fixture-observations.json)
and [static findings triage](security-trial-evidence/findings-triage.md) contain
sanitized historical evidence. Fixture inputs were synthetic. The original
selected-source report and native reports are not included. The summary above
records their historical observations and does not claim a fresh scan of this
public branch.