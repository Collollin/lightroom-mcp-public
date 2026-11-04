import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execute, inspect, exitCode } from '../scripts/security-trial.mjs';

const sentinel = 'PRIVATE_SENTINEL_DO_NOT_PUBLISH';
const context = { target: '/snapshot', inventory: new Set(['case.ts', 'package-lock.json']), ruleIds: new Set(['pinned.rule']) };
const result = code => ({ code, timedOut: false, signal: null });
const semgrep = (change = {}) => JSON.stringify({ version: '1.183.0', results: [], paths: { scanned: ['/snapshot/case.ts'] }, errors: [], skipped_rules: [], ...change });
const finding = { check_id: 'pinned.rule', path: '/snapshot/case.ts', start: { line: 1 }, extra: { message: sentinel, lines: sentinel, nested: { token: sentinel } } };
const log = (change = {}) => JSON.stringify({ level: 'info', msg: 'finished scanning', chunks: 1, bytes: 200, verified_secrets: 0, unverified_secrets: 0, trufflehog_version: '3.99.8', ...change });

test('clean and findings remain distinct and partial Semgrep results preserve findings', () => {
  assert.equal(inspect('semgrep', semgrep(), '', result(0), context).status, 'clean');
  assert.equal(inspect('semgrep', semgrep({ results: [finding] }), '', result(1), context).status, 'findings');
  const partial = inspect('semgrep', semgrep({ results: [finding], errors: [{ type: ['PartialParsing', sentinel], message: sentinel }] }), '', result(1), context);
  assert.equal(partial.status, 'incomplete');
  assert.equal(partial.findings.length, 1);
  assert.ok(!JSON.stringify(partial).includes(sentinel));
});

test('native config errors, malformed JSON, unexpected exits and zero inputs fail closed', () => {
  assert.equal(inspect('semgrep', semgrep({ errors: [{ message: sentinel }] }), '', result(2), context).status, 'error');
  for (const text of ['', '{', JSON.stringify({ message: sentinel })]) assert.equal(inspect('semgrep', text, sentinel, result(0), context).status, 'error');
  assert.equal(inspect('semgrep', semgrep(), '', result(17), context).status, 'error');
  assert.equal(inspect('semgrep', semgrep({ paths: { scanned: [] } }), '', result(0), context).status, 'incomplete');
  const omittedContext = { ...context, inventory: new Set(['fixture.ts', '.semgrepignore']) };
  assert.equal(inspect('semgrep', semgrep({ paths: { scanned: ['/snapshot/.semgrepignore'] } }), '', result(0), omittedContext).reason, 'target-omissions');
  assert.equal(inspect('semgrep', semgrep({ skipped_rules: [{ message: sentinel }] }), '', result(0), context).status, 'incomplete');
});

test('raw strings, unknown identifiers and paths cannot escape any adapter', () => {
  const secret = { DetectorType: 7, Verified: false, SourceMetadata: { Data: { Filesystem: { file: '/snapshot/case.ts', line: 1, token: sentinel } } }, Raw: sentinel, RawV2: sentinel, Redacted: sentinel, SecretParts: { nested: sentinel }, ExtraData: { token: sentinel } };
  const safe = inspect('trufflehog', JSON.stringify(secret), log({ unverified_secrets: 1, nested: sentinel }), result(183), context);
  assert.equal(safe.status, 'findings');
  assert.deepEqual(safe.findings, [{ detector: 7, path: 'case.ts', line: 1 }]);
  assert.ok(!JSON.stringify(safe).includes(sentinel));
  for (const malicious of [{ ...finding, check_id: sentinel }, { ...finding, path: '/outside/' + sentinel }, { ...finding, path: '../' + sentinel }]) {
    const rejected = inspect('semgrep', semgrep({ results: [malicious] }), sentinel, result(1), context);
    assert.equal(rejected.status, 'error');
    assert.ok(!JSON.stringify(rejected).includes(sentinel));
  }
});

test('empty valid TruffleHog JSONL needs its native completion log and no verification', () => {
  const clean = inspect('trufflehog', '', log(), result(0), context);
  assert.equal(clean.status, 'clean');
  assert.equal(clean.examined, null);
  assert.equal(inspect('trufflehog', '', '', result(0), context).status, 'incomplete');
  assert.equal(inspect('trufflehog', '', log() + '\n' + JSON.stringify({ level: 'error', msg: sentinel }), result(0), context).status, 'incomplete');
  assert.equal(inspect('trufflehog', '', log({ bytes: 0 }), result(0), context).status, 'incomplete');
  assert.equal(inspect('trufflehog', '', log({ verified_secrets: 1 }), result(0), context).status, 'error');
  assert.equal(inspect('trufflehog', '{', log(), result(183), context).status, 'error');
});

test('OSV requires actual packages and reports only advisory IDs and known paths', () => {
  const report = vulnerabilities => JSON.stringify({ results: [{ source: { path: '/snapshot/package-lock.json', type: 'lockfile' }, packages: [{ package: { name: sentinel, version: '1.0.0', ecosystem: 'npm' }, vulnerabilities }] }] });
  const advisory = { id: 'GHSA-35jh-r3h4-6jhm', summary: sentinel, details: sentinel, references: [{ url: sentinel }] };
  const found = inspect('osv', report([advisory]), sentinel, result(1), context);
  assert.equal(found.status, 'findings');
  assert.equal(found.examined, 1);
  assert.ok(!JSON.stringify(found).includes(sentinel));
  assert.equal(inspect('osv', report([]), '', result(0), context).status, 'clean');
  assert.equal(inspect('osv', report([]), '', result(1), context).status, 'error');
  assert.equal(inspect('osv', JSON.stringify({ results: [] }), '', result(0), context).status, 'incomplete');
  assert.equal(inspect('osv', report([{ id: sentinel }]), '', result(1), context).status, 'error');
});

test('OSV rejects missing, blank and non-string package identities without counting or publishing them', () => {
  const valid = { name: sentinel, version: '1.0.0', ecosystem: 'npm' };
  const packages = [{}, ...Object.keys(valid).flatMap(field => [undefined, '', ' \t', 1, null].map(value => ({ ...valid, [field]: value })))];
  for (const identity of packages) {
    const report = JSON.stringify({ results: [{ source: { path: '/snapshot/package-lock.json', type: 'lockfile' }, packages: [{ package: identity }] }] });
    const rejected = inspect('osv', report, sentinel, result(0), context);
    assert.deepEqual(rejected, { status: 'error', reason: 'malformed-report', findings: [], examined: null });
    assert.ok(!JSON.stringify(rejected).includes(sentinel));
  }
});

test('a real missing executable and killed subprocess never become a clean report', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'security-boundary-test-'));
  try {
    const missing = await execute(path.join(dir, 'missing'), [sentinel], dir, 1000);
    assert.equal(inspect('semgrep', missing.stdout, missing.stderr, missing, context).reason, 'invocation-failed');
    const killed = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], dir, 30);
    assert.equal(inspect('semgrep', killed.stdout, killed.stderr, killed, context).status, 'incomplete');
    const privateLogs = await execute(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]);', sentinel], dir, 1000);
    assert.equal(await readFile(path.join(dir, 'stdout'), 'utf8'), sentinel);
    const safe = inspect('semgrep', privateLogs.stdout, privateLogs.stderr, privateLogs, context);
    assert.ok(!JSON.stringify(safe).includes(sentinel));
    for (const [status, code] of Object.entries(exitCode)) assert.equal(code === 0, status === 'clean');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
