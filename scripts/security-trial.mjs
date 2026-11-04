#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(await readFile(path.join(root, 'security/trial-pins.json'), 'utf8'));
const tools = ['semgrep', 'osv', 'trufflehog'];
export const exitCode = { clean: 0, findings: 1, error: 2, incomplete: 3 };
const failure = (status, reason, findings = [], examined = null) => ({ status, reason, findings, examined });
const integer = n => Number.isSafeInteger(n) && n >= 0;
const array = value => { if (!Array.isArray(value)) throw Error(); return value; };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; };
const lines = text => text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

function safePath(value, context) {
  if (typeof value !== 'string') throw Error();
  const relative = path.relative(context.target, path.resolve(context.target, value)).split(path.sep).join('/');
  if (!context.inventory.has(relative)) throw Error();
  return relative;
}

/** Native reports stop at this boundary. No scanner messages or arbitrary metadata escape. */
export function inspect(tool, stdout, stderr, processResult, context) {
  if (processResult.spawnError) return failure('error', 'invocation-failed');
  if (processResult.timedOut || processResult.signal) return failure('incomplete', 'interrupted');
  let findings = [];
  let examined = null;
  try {
    if (tool === 'semgrep') {
      const report = object(JSON.parse(stdout));
      if (report.version !== pins.semgrep) return failure('error', 'unsupported-version');
      findings = array(report.results).map(item => {
        if (!context.ruleIds.has(item.check_id) || !integer(item.start?.line) || item.start.line < 1) throw Error();
        return { rule: item.check_id, path: safePath(item.path, context), line: item.start.line };
      });
      const scanned = new Set(array(object(report.paths).scanned).map(file => safePath(file, context)));
      examined = scanned.size;
      const errors = array(report.errors);
      const skips = array(report.skipped_rules);
      if (![0, 1].includes(processResult.code)) return failure('error', 'scanner-failed', findings, examined);
      if (errors.length || skips.length) return failure('incomplete', 'analysis-errors-or-skips', findings, examined);
      if ((processResult.code === 1) !== (findings.length > 0)) return failure('error', 'exit-report-mismatch', findings, examined);
      if (examined === 0) return failure('incomplete', 'zero-inputs', findings, examined);
      if ([...context.inventory].some(file => /\.(?:[cm]?[jt]sx?|ya?ml)$/.test(file) && !scanned.has(file))) return failure('incomplete', 'target-omissions', findings, examined);
    } else if (tool === 'osv') {
      const report = object(JSON.parse(stdout));
      const results = array(report.results);
      let count = 0;
      for (const result of results) {
        const file = safePath(result.source?.path, context);
        if (result.source.type !== 'lockfile') throw Error();
        for (const item of array(result.packages)) {
          const identity = object(item.package);
          if (['name', 'version', 'ecosystem'].some(field => typeof identity[field] !== 'string' || !identity[field].trim())) throw Error();
          count += 1;
          for (const vulnerability of array(item.vulnerabilities ?? [])) {
            if (!/^(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}|CVE-\d{4}-\d{4,})$/.test(vulnerability.id)) throw Error();
            findings.push({ rule: vulnerability.id, path: file });
          }
        }
      }
      examined = count;
      if (![0, 1].includes(processResult.code)) return failure('error', 'scanner-failed', findings, examined);
      if (!count) return failure('incomplete', 'zero-inputs', findings, examined);
      if ((processResult.code === 1) !== (findings.length > 0)) return failure('error', 'exit-report-mismatch', findings, examined);
    } else if (tool === 'trufflehog') {
      findings = lines(stdout).map(item => {
        if (!integer(item.DetectorType) || item.Verified !== false) throw Error();
        const source = object(item.SourceMetadata?.Data?.Filesystem);
        if (!integer(source.line) || source.line < 1) throw Error();
        return { detector: item.DetectorType, path: safePath(source.file, context), line: source.line };
      });
      const logs = lines(stderr);
      if (![0, 183].includes(processResult.code)) return failure('error', 'scanner-failed', findings);
      const completion = logs.filter(item => item.msg === 'finished scanning');
      if (completion.length !== 1) return failure('incomplete', 'missing-completion', findings);
      const done = completion[0];
      if (done.trufflehog_version !== pins.trufflehog || !integer(done.chunks) || !integer(done.bytes) || !integer(done.unverified_secrets) || done.verified_secrets !== 0) throw Error();
      if (logs.some(item => item.level === 'error' || item.level === 'fatal')) return failure('incomplete', 'scan-errors', findings);
      if (done.unverified_secrets !== findings.length || (processResult.code === 183) !== (findings.length > 0)) return failure('error', 'exit-report-mismatch', findings);
      if (done.bytes === 0) return failure('incomplete', 'zero-inputs', findings);
    } else throw Error();
    return { status: findings.length ? 'findings' : 'clean', reason: 'completed', findings, examined };
  } catch {
    return failure('error', 'malformed-report', findings, examined);
  }
}

export async function execute(command, args, directory, timeout, env = process.env, cwd = root) {
  const stdoutPath = path.join(directory, 'stdout');
  const stderrPath = path.join(directory, 'stderr');
  const out = openSync(stdoutPath, 'w', 0o600);
  const err = openSync(stderrPath, 'w', 0o600);
  let result;
  try {
    result = await new Promise(resolve => {
      let timedOut = false;
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', out, err], detached: process.platform !== 'win32' });
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, timeout);
      child.once('error', () => { clearTimeout(timer); resolve({ spawnError: true }); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut }); });
    });
  } finally { closeSync(out); closeSync(err); }
  return { ...result, stdout: await readFile(stdoutPath, 'utf8'), stderr: await readFile(stderrPath, 'utf8') };
}

async function inventory(directory, prefix = '', targetRoot = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await inventory(path.join(directory, entry.name), name + '/', targetRoot));
    else if (entry.isFile()) files.push(name);
    else if (entry.isSymbolicLink()) {
      const resolved = await realpath(path.join(directory, entry.name));
      const relative = path.relative(targetRoot, resolved);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !(await stat(resolved)).isFile()) throw Error();
      files.push(name);
    } else throw Error();
  }
  return files.sort();
}

async function scan(tool, target, scratch, config, revision, scope, caseId) {
  const dir = await mkdtemp(path.join(scratch, tool + '-'));
  const submitted = await inventory(target);
  const ignoreFile = path.join(target, '.semgrepignore');
  let originalIgnore = null;
  const ruleFile = path.join(config.toolsDir, 'rules.json');
  let ruleIds = new Set();
  let ruleDigest = null;
  const binary = tool === 'semgrep' ? path.join(config.toolsDir, 'semgrep-venv/bin/semgrep') : path.join(config.toolsDir, tool === 'osv' ? 'osv-scanner' : 'trufflehog');
  const env = { ...process.env, SEMGREP_APP_TOKEN: '', SEMGREP_SETTINGS_FILE: path.join(scratch, 'semgrep-settings.yml'), SEMGREP_SEND_METRICS: 'off' };
  let inspected;
  let nativeExit = null;
  try {
    const version = await execute(binary, ['--version'], dir, config.timeout, env);
    if (version.spawnError) inspected = failure('error', 'invocation-failed');
    else if (version.timedOut || version.signal) inspected = failure('incomplete', 'interrupted');
    else if (version.code !== 0 || !new RegExp(`(?:^|[^0-9])${pins[tool].replaceAll('.', '\\.')}([^0-9]|$)`).test(version.stdout + version.stderr)) inspected = failure('error', 'unsupported-version');
    if (!inspected) {
      let args;
      if (tool === 'semgrep') {
        if (submitted.includes('.semgrepignore')) {
          if (!(await lstat(ignoreFile)).isFile()) throw Error();
          originalIgnore = await readFile(ignoreFile);
        }
        await writeFile(ignoreFile, '', { mode: 0o600 });
        const rules = await readFile(ruleFile);
        ruleDigest = createHash('sha256').update(rules).digest('hex');
        if (ruleDigest !== pins.rulesJsonSha256) throw Error();
        ruleIds = new Set(array(JSON.parse(rules).rules).map(rule => rule.id));
        if (ruleIds.size !== 228) throw Error();
        const selectedRules = caseId === 'invalid-config' ? path.join(dir, 'invalid.yaml') : ruleFile;
        if (caseId === 'invalid-config') await writeFile(selectedRules, 'rules: [unterminated\n', { mode: 0o600 });
        args = ['scan', '--config', selectedRules, '--oss-only', '--disable-version-check', '--metrics=off', '--json', '--error', '--no-rewrite-rule-ids', '--no-git-ignore', ...(caseId === 'oversized-file' ? ['--max-target-bytes=64'] : []), target];
      } else if (tool === 'osv') {
        args = ['scan', 'source', '--lockfile=' + path.join(target, scope === 'repository' ? 'server/package-lock.json' : 'package-lock.json'), '--format=json', '--all-packages', '--all-vulns', '--no-call-analysis=all', '--no-resolve'];
      } else args = ['filesystem', '--no-verification', '--no-update', '--json', '--fail', '--fail-on-scan-errors', caseId === 'missing-path' ? path.join(target, 'nonexistent') : target];
      const processResult = await execute(binary, args, dir, config.timeout, env, scratch);
      nativeExit = processResult.code ?? null;
      inspected = inspect(tool, processResult.stdout, processResult.stderr, processResult, { target, inventory: new Set(tool === 'semgrep' ? [...submitted, '.semgrepignore'] : submitted), ruleIds });
    }
  } catch { inspected = failure('error', 'invalid-configuration'); }
  finally {
    if (tool === 'semgrep') {
      if (originalIgnore !== null) await writeFile(ignoreFile, originalIgnore);
      else if (!submitted.includes('.semgrepignore')) await rm(ignoreFile, { force: true });
    }
  }
  return { tool, version: pins[tool], scope, ...(caseId ? { case: caseId } : {}), revision, observedAt: new Date().toISOString(), ruleCommit: tool === 'semgrep' ? pins.rulesCommit : null, ruleDigest, nativeExit, submittedFiles: submitted.length, scanPolicy: tool === 'semgrep' ? 'empty-semgrepignore-override' : 'explicit-lockfile-or-filesystem', examined: inspected.examined, examinedUnit: tool === 'osv' ? 'package-version-entries' : tool === 'semgrep' ? 'files' : 'unavailable', historyScanned: false, advisorySource: tool === 'osv' ? 'https://api.osv.dev' : null, ...inspected };
}

async function fixture(directory, files) {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { mode: 0o600 });
  }
}

export async function generateFixtures(base) {
  const mcp = `import { z } from 'zod';\nimport { exec, execFile } from 'node:child_process';\ndeclare const server: any;\n`;
  const register = body => `${mcp}server.registerTool('run', {}, async ({command}) => { ${body} return {}; });\n`;
  const lock = version => JSON.stringify({ name: 'inert-scanner-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'inert-scanner-fixture', version: '1.0.0', dependencies: { lodash: version } }, 'node_modules/lodash': { version, resolved: `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz` } } });
  const cases = [
    { tool: 'semgrep', id: 'same-file-bad', semanticExpectation: 'unsafe', expected: 'findings', expectedRule: 'typescript.mcp.security.mcp-command-injection-typescript.mcp-command-injection-typescript', files: { 'case.ts': register('exec(command);') } },
    { tool: 'semgrep', id: 'same-file-good', semanticExpectation: 'safe', expected: 'clean', files: { 'case.ts': register("execFile('printf', ['%s', command]);") } },
    { tool: 'semgrep', id: 'cross-file-bad', semanticExpectation: 'unsafe', expected: 'observe-gap', expectedRule: 'typescript.mcp.security.mcp-command-injection-typescript.mcp-command-injection-typescript', files: { 'case.ts': `import { run } from './helper';\n${register('run(command);')}`, 'helper.ts': "import { exec } from 'node:child_process'; export function run(value: string) { exec(value); }" } },
    { tool: 'semgrep', id: 'cross-file-good', semanticExpectation: 'safe', expected: 'observe-gap', files: { 'case.ts': `import { run } from './helper';\n${register('run(command);')}`, 'helper.ts': "import { execFile } from 'node:child_process'; export function run(value: string) { execFile('printf', ['%s', value]); }" } },
    { tool: 'semgrep', id: 'source-free-sink', semanticExpectation: 'source-free-control', expected: 'observe-gap', files: { 'helper.ts': "import { exec } from 'node:child_process'; export function run(value: string) { exec(value); }" } },
    { tool: 'semgrep', id: 'schema-parse-gap', semanticExpectation: 'unsafe', expected: 'observe-gap', expectedRule: 'typescript.mcp.security.mcp-command-injection-typescript.mcp-command-injection-typescript', files: { 'case.ts': register('const parsed = z.string().parse(command); exec(parsed);') } },
    { tool: 'semgrep', id: 'action-parser-gap', semanticExpectation: 'unsafe', expected: 'incomplete', expectedRule: 'yaml.github-actions.security.run-shell-injection.run-shell-injection', files: { 'case.yml': 'name: inert fixture\non: issues\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.event.issue.title }}"\n' } },
    { tool: 'semgrep', id: 'invalid-config', semanticExpectation: 'invalid-configuration', expected: 'error', files: { 'case.ts': 'export const ordinary = 1;\n' } },
    { tool: 'semgrep', id: 'oversized-file', semanticExpectation: 'omitted-target', expected: 'incomplete', files: { 'fixture.ts': 'export const ordinary = 1;\n' + ' '.repeat(2000) } },
    { tool: 'osv', id: 'dependency-bad', semanticExpectation: 'known-vulnerable', expected: 'findings', expectedRule: 'GHSA-35jh-r3h4-6jhm', files: { 'package-lock.json': lock('4.17.20') } },
    { tool: 'osv', id: 'dependency-good', semanticExpectation: 'fixed-control', expected: 'clean', files: { 'package-lock.json': lock('4.18.1') } },
    { tool: 'osv', id: 'invalid-lock', semanticExpectation: 'invalid-input', expected: 'error', files: { 'package-lock.json': '{' } },
    { tool: 'trufflehog', id: 'secret-bad', semanticExpectation: 'non-live-detector-positive', expected: 'findings', files: { 'case.txt': 'github_token = ghp_' + 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5' + '\n' } },
    { tool: 'trufflehog', id: 'secret-good', semanticExpectation: 'ordinary-control', expected: 'clean', files: { 'case.txt': 'This ordinary string contains no credential.\n' } },
    { tool: 'trufflehog', id: 'missing-path', semanticExpectation: 'invalid-input', expected: 'error', files: { 'case.txt': 'ordinary\n' } },
  ];
  for (const item of cases) await fixture(path.join(base, item.id), item.files);
  return cases.map(({ files, ...item }) => item);
}

async function publish(output, command, results) {
  await mkdir(output, { recursive: true });
  const report = { schema: 1, command, results };
  await writeFile(path.join(output, command + '.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const summary = results.map(result => `${result.tool} ${result.case ?? 'repository'} ${result.status} ${result.reason} findings=${result.findings.length} examined=${result.examined ?? 'unavailable'}${result.assertion ? ' assertion=' + result.assertion : ''}`).join('\n') + '\n';
  await writeFile(path.join(output, command + '-summary.txt'), summary, { mode: 0o600 });
  process.stdout.write(summary);
}

async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  const command = args.shift();
  const config = { toolsDir: path.join(homedir(), '.cache/lightroom-mcp-security'), output: path.join(root, '.security-trial'), revision: 'HEAD', timeout: 300000, tool: 'all' };
  while (args.length) {
    const name = args.shift();
    const value = args.shift();
    if (!value || !['--tools-dir', '--output', '--revision', '--timeout', '--tool'].includes(name)) throw Error();
    config[{ '--tools-dir': 'toolsDir', '--output': 'output', '--revision': 'revision', '--timeout': 'timeout', '--tool': 'tool' }[name]] = value;
  }
  if (!['scan', 'verify'].includes(command) || !['all', ...tools].includes(config.tool) || !/^\d+$/.test(String(config.timeout)) || Number(config.timeout) < 1) throw Error();
  config.toolsDir = path.resolve(config.toolsDir);
  config.output = path.resolve(config.output);
  config.timeout = Number(config.timeout);
  const scratch = await mkdtemp(path.join(tmpdir(), 'lrmcp-security-'));
  await chmod(scratch, 0o700);
  try {
    const git = await execute('git', ['rev-parse', '--verify', '--end-of-options', config.revision + '^{commit}'], scratch, 10000);
    const revision = git.stdout.trim();
    if (git.code !== 0 || !/^[0-9a-f]{40}$/.test(revision)) throw Error();
    const selected = config.tool === 'all' ? tools : [config.tool];
    const results = [];
    if (command === 'scan') {
      const target = path.join(scratch, 'snapshot');
      await mkdir(target);
      const archive = await execute('git', ['archive', '--format=tar', revision], scratch, 10000);
      if (archive.code !== 0) throw Error();
      const unpack = await execute('tar', ['-xf', path.join(scratch, 'stdout'), '-C', target], await mkdtemp(path.join(scratch, 'unpack-')), 10000);
      if (unpack.code !== 0) throw Error();
      for (const tool of selected) results.push(await scan(tool, target, scratch, config, revision, 'repository'));
    } else {
      const base = path.join(scratch, 'fixtures');
      for (const item of await generateFixtures(base)) {
        if (!selected.includes(item.tool)) continue;
        const result = await scan(item.tool, path.join(base, item.id), scratch, config, revision, 'fixtures', item.id);
        const complete = ['clean', 'findings'].includes(result.status);
        result.expected = item.expected;
        result.semanticExpectation = item.semanticExpectation;
        result.targetRuleObserved = item.expectedRule ? result.findings.some(f => f.rule === item.expectedRule) : null;
        result.expectedRule = item.expectedRule ?? null;
        result.assertion = item.expected === 'observe-gap' ? (complete ? 'observed' : 'failed') : result.status === item.expected && (!item.expectedRule || result.findings.some(f => f.rule === item.expectedRule)) ? 'passed' : 'failed';
        results.push(result);
      }
    }
    await publish(config.output, command, results);
    process.exitCode = command === 'verify' ? (results.every(r => r.assertion !== 'failed') ? 0 : 2) : Math.max(...results.map(r => exitCode[r.status]));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('security-trial error invalid-invocation-or-snapshot\n'); process.exitCode = 2; });
}
