// Checks what can actually be checked before running examples.
//   npm run doctor                 readable report
//   npm run doctor -- --json       stable JSON (schema: docs/doctor.md)
//   npm run doctor -- --launch     also launch + connect + gracefully stop the profile (end-to-end)
// Exit code 0 when no check failed; otherwise the exit code of the first failing check's kind.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ENV_FILE, flagOverrides, loadConfig, type StarterConfig } from '../lib/config.js';
import { EXIT_CODES, StarterError, sanitize, type FailureKind } from '../lib/errors.js';
import { checkAlive, createApi, getProfileStatus, READY } from '../lib/incogniton.js';
import { openPlaywrightSession } from '../lib/playwright-session.js';

type Status = 'pass' | 'warn' | 'fail' | 'unknown' | 'skip';
interface Check {
  id: string;
  status: Status;
  message: string;
  hint?: string;
  /** Failure kind used for the exit code when status is "fail". */
  kind?: FailureKind;
  data?: Record<string, unknown>;
}

const { values } = parseArgs({
  options: { json: { type: 'boolean' }, launch: { type: 'boolean' }, 'profile-id': { type: 'string' }, port: { type: 'string' } },
});
const checks: Check[] = [];
const add = (check: Check) => checks.push(check);

function installedVersion(name: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(resolve('node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return undefined;
  }
}

// 1. Runtime and dependencies
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
add(
  major > 22 || (major === 22 && minor >= 12)
    ? { id: 'node', status: 'pass', message: `Node.js ${process.version}` }
    : { id: 'node', status: 'fail', kind: 'config_invalid', message: `Node.js ${process.version} is too old`, hint: 'Install Node.js 22.12 or newer (LTS).' },
);
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
const deps = Object.entries(pkg.dependencies).map(([name, wanted]) => ({ name, wanted, installed: installedVersion(name) }));
const badDeps = deps.filter((d) => d.installed !== d.wanted);
add(
  badDeps.length === 0
    ? { id: 'dependencies', status: 'pass', message: deps.map((d) => `${d.name}@${d.installed}`).join(', '), data: { deps } }
    : { id: 'dependencies', status: 'fail', kind: 'config_invalid', message: `Missing or mismatched: ${badDeps.map((d) => `${d.name} (want ${d.wanted}, have ${d.installed ?? 'none'})`).join(', ')}`, hint: 'Run `npm ci`.' },
);

// 2. Configuration
add(existsSync(ENV_FILE) ? { id: 'env_file', status: 'pass', message: '.env found' } : { id: 'env_file', status: 'warn', message: 'No .env file; using defaults and environment variables', hint: 'Run `npm run setup`.' });
let config: StarterConfig | undefined;
try {
  config = loadConfig(flagOverrides(values));
  add({ id: 'config', status: 'pass', message: `API port ${config.apiPort}, headless=${config.headless}, launch timeout ${config.launchTimeoutMs} ms` });
} catch (error) {
  add({ id: 'config', status: 'fail', kind: 'config_invalid', message: (error as Error).message, hint: (error as StarterError).hint });
}

// 3. API
if (config) {
  const api = createApi(config);
  const alive = await checkAlive(config.apiPort);
  if (!alive.ok) {
    add({
      id: 'api_reachable',
      status: 'fail',
      kind: 'api_unreachable',
      message: `No Incogniton API on 127.0.0.1:${config.apiPort} (${alive.error ?? `unexpected response "${alive.body}"`})`,
      hint:
        'Possible causes (the API cannot tell them apart; it simply does not listen): the desktop app is not running, you are not logged in, ' +
        'the API is disabled or uses another port (Settings > Automation), or your plan does not include automation.',
    });
  } else {
    add({ id: 'api_reachable', status: 'pass', message: `GET /alive on 127.0.0.1:${config.apiPort} returned OK` });
    try {
      const list = (await api.client.profile.list()) as unknown as { status?: string; profileData?: unknown[] };
      add(
        Array.isArray(list.profileData)
          ? { id: 'api_profiles', status: 'pass', message: `Profile list returned ${list.profileData.length} profile(s)`, data: { count: list.profileData.length } }
          : { id: 'api_profiles', status: 'fail', kind: 'api_error', message: `Unexpected profile list response (status=${String(list.status)})` },
      );
    } catch (error) {
      add({ id: 'api_profiles', status: 'fail', kind: 'api_error', message: sanitize((error as Error).message) });
    }
    add({ id: 'app_version', status: 'unknown', message: 'The local API exposes no app version endpoint; not checked.' });
    add({ id: 'automation_entitlement', status: 'unknown', message: 'Not directly queryable. A reachable API means automation is enabled for this login; plan limits (e.g. launch limits) only show up when launching.' });

    // 4. Profile
    if (!config.profileId) {
      add({ id: 'profile', status: 'warn', message: 'INCOGNITON_PROFILE_ID is not set', hint: 'npm run profiles -- list, then npm run setup -- --profile-id <id>' });
    } else {
      try {
        const status = await getProfileStatus(api, config.profileId);
        const { profileData } = await api.client.profile.get(config.profileId);
        const general = profileData.general_profile_information ?? {};
        const data = { profileId: config.profileId, status, browserVersion: general.profile_browser_version, group: general.profile_group };
        if (status === READY) add({ id: 'profile', status: 'pass', message: `Profile ${config.profileId} is Ready (browser version ${general.profile_browser_version ?? '?'})`, data });
        else add({ id: 'profile', status: 'warn', message: `Profile ${config.profileId} is "${status}"; examples need it to be Ready`, hint: 'Close the profile in the app or stop the session that opened it.', data });
      } catch (error) {
        const e = error as StarterError;
        add({ id: 'profile', status: 'fail', kind: e.kind ?? 'unknown', message: e.message, hint: e.hint });
      }
    }

    // 5. Optional end-to-end launch
    if (values.launch && config.profileId && checks.every((c) => c.status !== 'fail')) {
      const started = Date.now();
      try {
        const session = await openPlaywrightSession(config, { profileId: config.profileId });
        const contexts = session.browser.contexts().length;
        const report = await session.close();
        add({
          id: 'launch_connect',
          status: report.ok ? 'pass' : 'warn',
          message: `Launched, connected (${session.browserVersion}, ${contexts} context(s)) and stopped via ${report.method} in ${Date.now() - started} ms`,
          data: { browserVersion: session.browserVersion, cleanup: report },
        });
      } catch (error) {
        const e = error as StarterError;
        add({ id: 'launch_connect', status: 'fail', kind: e.kind ?? 'unknown', message: sanitize(e.message), hint: e.hint });
      }
    } else if (!values.launch) {
      add({ id: 'launch_connect', status: 'skip', message: 'Not run. Use `npm run doctor -- --launch` for an end-to-end launch test.' });
    }
  }
}

const firstFail = checks.find((c) => c.status === 'fail');
const exitCode = firstFail ? EXIT_CODES[firstFail.kind ?? 'unknown'] : 0;
if (values.json) {
  console.log(JSON.stringify({ schemaVersion: 1, ok: !firstFail, exitCode, generatedAt: new Date().toISOString(), checks }, null, 2));
} else {
  const icon: Record<Status, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', unknown: '????', skip: 'SKIP' };
  for (const c of checks) {
    console.log(`[${icon[c.status]}] ${c.id}: ${c.message}`);
    if (c.hint && c.status !== 'pass') console.log(`       hint: ${c.hint}`);
  }
  console.log(firstFail ? `\nDoctor found a problem (exit code ${exitCode}).` : '\nNo blocking problems found.');
}
process.exitCode = exitCode;
