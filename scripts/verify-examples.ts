// Live verification against a REAL, running, logged-in Incogniton desktop app.
// Runs every example in examples/index.json plus failure-path checks, then writes
// docs/compatibility.json (and a run report under output/verify/).
//   npm run test:live                         all examples + failure paths
//   npm run test:live -- --only <id>[,<id>]   a subset (compatibility.json is then not rewritten)
//   npm run test:live -- --skip-python
// Needs INCOGNITON_PROFILE_ID (a dedicated test profile). For run-multiple-profiles it uses
// INCOGNITON_PROFILE_IDS, or creates two temporary profiles and deletes them afterwards.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, requireProfileId } from '../lib/config.js';
import { EXIT_CODES, StarterError } from '../lib/errors.js';
import { checkAlive, createApi, getProfileStatus, READY } from '../lib/incogniton.js';
import { readManifest } from '../lib/manifest.js';
import { openPlaywrightSession } from '../lib/playwright-session.js';
import { createRecordedProfile, deleteRecordedProfile } from '../lib/profiles.js';

const { values } = parseArgs({ options: { only: { type: 'string' }, 'skip-python': { type: 'boolean' } } });
const config = loadConfig();
const api = createApi(config);
const profileId = requireProfileId(config);
const started = new Date();
const reportDir = resolve(config.outputDir, 'verify', started.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-'));
mkdirSync(reportDir, { recursive: true });

if (!(await checkAlive(config.apiPort)).ok) {
  console.error(`Incogniton API not reachable on 127.0.0.1:${config.apiPort}; live verification is blocked. Run npm run doctor.`);
  process.exit(EXIT_CODES.api_unreachable);
}

const tsxCli = resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
const python = [resolve('.venv', 'Scripts', 'python.exe'), resolve('.venv', 'bin', 'python')].find((p) => existsSync(p));

interface Outcome {
  id: string;
  kind: 'example' | 'failure-path' | 'lifecycle';
  status: 'verified' | 'failed' | 'not-run';
  exitCode: number | null;
  expectedExitCode?: number;
  durationMs: number;
  command: string;
  note?: string;
  browser?: string;
}
const outcomes: Outcome[] = [];

function exec(label: string, command: string, args: string[], env: Record<string, string> = {}) {
  const t = Date.now();
  console.log(`\n>>> ${label}: ${[command === process.execPath ? 'node' : command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 15 * 60 * 1000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(reportDir, `${label.replace(/[^\w-]+/g, '_')}.log`), output);
  const tail = output.trim().split('\n').slice(-6).join('\n');
  console.log(tail);
  return { code: result.status, durationMs: Date.now() - t, output };
}
const ts = (source: string, args: string[] = [], env?: Record<string, string>) => exec(source, process.execPath, [tsxCli, source, ...args], env);
const browserFrom = (output: string) => /(?:Chrome\/)?(\d{3}\.\d+\.\d+\.\d+)/.exec(output)?.[1];

function record(o: Outcome) {
  outcomes.push(o);
  console.log(`${o.status === 'verified' ? 'VERIFIED' : o.status === 'failed' ? 'FAILED' : 'NOT RUN'} ${o.id}${o.note ? ` (${o.note})` : ''}`);
}

async function ensureReady(id: string) {
  const status = await getProfileStatus(api, id);
  if (status !== READY) throw new StarterError('profile_busy', `Profile ${id} is "${status}" before a step; aborting verification to avoid touching a running browser.`);
}

// ---------------------------------------------------------------- examples
const only = values.only ? new Set(values.only.split(',')) : undefined;
const examples = readManifest().examples.filter((e) => !only || only.has(e.id));
let multiIds = config.profileIds.length >= 2 ? config.profileIds : [];
const temporary: string[] = [];

for (const entry of examples) {
  await ensureReady(profileId);
  const needs = new Set(entry.verify.needs);
  const command = entry.command;
  if (needs.has('python') && (values['skip-python'] || !python)) {
    record({ id: entry.id, kind: 'example', status: 'not-run', exitCode: null, durationMs: 0, command, note: python ? 'skipped by flag' : 'no .venv with requirements.lock installed' });
    continue;
  }
  if (needs.has('two-profiles') && multiIds.length < 2) {
    for (let i = 0; i < 2; i++) temporary.push(await createRecordedProfile(api, { name: `starter-verify-${i + 1}`, createdBy: 'scripts/verify-examples.ts' }));
    multiIds = temporary;
  }
  let result;
  if (needs.has('session')) {
    const start = ts('scripts/session.ts', ['start']);
    result = start.code === 0 ? ts(entry.source, entry.verify.args) : start;
    const stop = ts('scripts/session.ts', ['stop']);
    if (stop.code !== 0) result = { ...result, code: result.code || stop.code };
  } else if (entry.language === 'python') {
    result = exec(entry.source, python!, [entry.source, ...entry.verify.args]);
  } else if (needs.has('two-profiles')) {
    result = ts(entry.source, ['--profile-ids', multiIds.join(','), ...entry.verify.args]);
  } else {
    result = ts(entry.source, entry.verify.args);
  }
  record({ id: entry.id, kind: 'example', status: result.code === 0 ? 'verified' : 'failed', exitCode: result.code, durationMs: result.durationMs, command, browser: browserFrom(result.output) });
}

// ---------------------------------------------------------------- failure paths
const runFailurePaths = !only;
if (runFailurePaths) {
  const expect = (id: string, expected: number, r: { code: number | null; durationMs: number; output: string }, command: string, extra?: () => string | undefined) => {
    const problem = r.code !== expected ? `exit ${r.code}, expected ${expected}` : extra?.();
    record({ id, kind: 'failure-path', status: problem ? 'failed' : 'verified', exitCode: r.code, expectedExitCode: expected, durationMs: r.durationMs, command, note: problem });
  };
  const form = 'examples/playwright/click-and-fill-form.ts';

  expect('unknown-profile-id', EXIT_CODES.profile_not_found, ts(form, ['--profile-id', '00000000-0000-4000-8000-000000000000']), 'npm run example:form -- --profile-id <unknown>');
  expect('api-unreachable-port-override', EXIT_CODES.api_unreachable, ts(form, ['--port', '35999']), 'npm run example:form -- --port 35999');
  expect('invalid-configuration', EXIT_CODES.config_invalid, ts(form, ['--profile-id', 'not-a-uuid']), 'npm run example:form -- --profile-id not-a-uuid');

  await ensureReady(profileId);
  ts('scripts/session.ts', ['start']);
  const busy = ts(form);
  ts('scripts/session.ts', ['stop']);
  expect('profile-already-open', EXIT_CODES.profile_busy, busy, 'npm run session -- start; npm run example:form', () => (busy.durationMs > 15000 ? `took ${busy.durationMs} ms; expected a fast preflight rejection` : undefined));

  await ensureReady(profileId);
  const timeout = ts('starter/src/main.ts', ['--workflow', 'failure-demo']);
  expect('page-timeout-with-artifacts', EXIT_CODES.timeout, timeout, 'npm start -- --workflow failure-demo', () => {
    const dir = join(config.outputDir, 'starter');
    const latest = readdirSync(dir).map((d) => join(dir, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
    const result = JSON.parse(readFileSync(join(latest, 'result.json'), 'utf8')) as { artifacts: string[]; cleanup: Array<{ ok: boolean }> };
    if (!result.artifacts.some((a) => a.includes('failure-'))) return 'no failure screenshot recorded';
    if (!result.cleanup.every((c) => c.ok)) return 'cleanup did not succeed after the failure';
    return undefined;
  });

  // Cancellation during launch: the helper must not leave the browser running.
  await ensureReady(profileId);
  const t = Date.now();
  const controller = new AbortController();
  setTimeout(() => controller.abort(new StarterError('cancelled', 'cancelled by verify-examples')), 500);
  let cancelNote: string | undefined;
  try {
    const session = await openPlaywrightSession(config, { profileId, signal: controller.signal });
    await session.close();
    cancelNote = 'session opened despite cancellation';
  } catch (error) {
    if ((error as StarterError).kind !== 'cancelled') cancelNote = `unexpected error: ${(error as Error).message}`;
  }
  const deadline = Date.now() + config.stopTimeoutMs;
  let after = await getProfileStatus(api, profileId);
  while (after !== READY && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    after = await getProfileStatus(api, profileId);
  }
  if (!cancelNote && after !== READY) cancelNote = `profile left in status ${after}`;
  record({ id: 'cancellation-during-launch', kind: 'failure-path', status: cancelNote ? 'failed' : 'verified', exitCode: null, durationMs: Date.now() - t, command: 'in-process AbortSignal during openPlaywrightSession', note: cancelNote ?? `profile back to ${after}` });
}

// ---------------------------------------------------------------- cleanup and report
for (const id of temporary) {
  const report = await deleteRecordedProfile(api, id, { stopTimeoutMs: config.stopTimeoutMs });
  if (!report.ok) console.error(`LEFTOVER temporary profile ${id}: ${report.error}`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
const pyPins = Object.fromEntries(readFileSync('requirements.txt', 'utf8').split('\n').filter((l) => l.includes('==')).map((l) => l.trim().split('==') as [string, string]));
const pythonVersion = python ? spawnSync(python, ['--version'], { encoding: 'utf8' }).stdout.trim() : undefined;
const browser = outcomes.find((o) => o.browser)?.browser;
const host = `${os.type()} ${os.release()} ${os.arch()}`;
const date = started.toISOString().slice(0, 10);
const summary = {
  verified: outcomes.filter((o) => o.status === 'verified').length,
  failed: outcomes.filter((o) => o.status === 'failed').length,
  notRun: outcomes.filter((o) => o.status === 'not-run').length,
};
writeFileSync(join(reportDir, 'outcomes.json'), `${JSON.stringify({ summary, outcomes }, null, 2)}\n`);

if (!only) {
  const compatibility = {
    $comment: 'Generated by `npm run test:live` (scripts/verify-examples.ts). Live results come only from real Incogniton runs; nothing here is inferred.',
    schemaVersion: 1,
    generatedAt: started.toISOString(),
    statusValues: {
      verified: 'ran successfully against a real Incogniton desktop app on the listed host',
      failed: 'ran and failed on the listed host',
      'not-run': 'not executed in this verification run',
      'documented-unverified': 'supported by the product according to its documentation, but not verified by this repository',
      unsupported: 'not supported by the product',
      blocked: 'cannot be verified without access that was not available',
    },
    host: { description: host, platform: process.platform, arch: process.arch, node: process.version, python: pythonVersion },
    desktopApp: { version: 'unknown (the local API exposes no version endpoint)', apiPort: config.apiPort, browser: browser ? `Chrome ${browser}` : undefined },
    packages: {
      npm: { incogniton: pkg.dependencies.incogniton, 'playwright-core': pkg.dependencies['playwright-core'], 'puppeteer-core': pkg.dependencies['puppeteer-core'] },
      pypi: { incogniton: pyPins.incogniton, playwright: pyPins.playwright, selenium: pyPins.selenium },
    },
    platforms: [
      { platform: host, status: summary.failed === 0 ? 'verified' : 'failed', date },
      { platform: 'Windows 10/11 desktop', status: 'documented-unverified' },
      { platform: 'macOS (Apple silicon / Intel)', status: 'documented-unverified' },
      { platform: 'Linux, Docker/containers', status: 'unsupported', note: 'The Incogniton desktop app is distributed for Windows and macOS only.' },
      { platform: 'Hosted CI runners (GitHub Actions)', status: 'blocked', note: 'Needs an installed, logged-in desktop app and an account with automation; only static and fixture checks run there.' },
    ],
    summary,
    liveResults: outcomes.filter((o) => o.kind === 'example').map((o) => ({ exampleId: o.id, status: o.status, date, host, browser: o.browser ? `Chrome ${o.browser}` : undefined, command: o.command, durationMs: o.durationMs, note: o.note })),
    failurePathResults: outcomes.filter((o) => o.kind !== 'example').map((o) => ({ check: o.id, status: o.status, expectedExitCode: o.expectedExitCode, exitCode: o.exitCode, date, command: o.command, note: o.note })),
  };
  writeFileSync('docs/compatibility.json', `${JSON.stringify(compatibility, null, 2)}\n`);
  console.log('\nwrote docs/compatibility.json (run `npm run docs:generate` to refresh status in the docs)');
}
console.log(`\nLive verification: ${summary.verified} verified, ${summary.failed} failed, ${summary.notRun} not run. Logs: ${reportDir}`);
process.exitCode = summary.failed ? 1 : 0;
