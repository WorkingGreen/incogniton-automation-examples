/**
 * Contract tests for lib/incogniton.ts against a FAKE local API that replays response
 * shapes observed from the real app. They check the helpers' decisions (preflight,
 * envelope handling, shutdown fallback). They are NOT evidence that Incogniton works;
 * live behaviour is covered by `npm run test:live`.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApi, launchProfile, shutdownOwnedProfile, type IncognitonApi } from '../../lib/incogniton.js';
import type { StarterError } from '../../lib/errors.js';

const READY_ID = '11111111-1111-4111-8111-111111111111';
const OPEN_ID = '22222222-2222-4222-8222-222222222222';
const CONFLICT_ID = '33333333-3333-4333-8333-333333333333';
const STUCK_ID = '44444444-4444-4444-8444-444444444444';
const calls: string[] = [];
const status: Record<string, string> = { [READY_ID]: 'Ready', [OPEN_ID]: 'Launched', [CONFLICT_ID]: 'Ready', [STUCK_ID]: 'Launched' };
let server: Server;
let api: IncognitonApi;

before(async () => {
  server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    const send = (body: unknown) => res.end(JSON.stringify(body));
    const id = req.url!.split('/').filter(Boolean).pop()!;
    if (req.url!.startsWith('/profile/status/')) {
      return send(status[id] ? { status: status[id] } : { status: 'error', message: 'No profile found with that browser id.' });
    }
    if (req.url!.startsWith('/profile/stop/')) {
      status[id] = 'Ready';
      return send({ status: 'ok', message: 'Profile stopped' });
    }
    if (req.url === '/automation/launch/puppeteer') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const profileId = JSON.parse(body).profileID as string;
        // Replays the real response for a profile whose browser is already running (HTTP 200).
        if (profileId === CONFLICT_ID) return send({ status: 'error', message: "Browser for 'x' exited 21 (0x15) after 162ms" });
        return send({ status: 'error', message: "Profile doesn't exist" });
      });
      return;
    }
    send({ status: 'error', message: `Not found: ${req.method} ${req.url}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  api = createApi({ apiPort: (server.address() as AddressInfo).port, apiTimeoutSeconds: 5, launchTimeoutMs: 10000 });
});
after(() => server.close());

const launch = (id: string) => launchProfile(api, id, { headless: true, deadline: Date.now() + 3000 });

test('an open profile is rejected before any launch request is sent', async () => {
  calls.length = 0;
  await assert.rejects(launch(OPEN_ID), (e: StarterError) => e.kind === 'profile_busy');
  assert.ok(!calls.some((c) => c.startsWith('POST /automation/launch')), 'launch must not be called for an open profile');
});

test('an unknown profile id maps to profile_not_found', async () => {
  await assert.rejects(launch('55555555-5555-4555-8555-555555555555'), (e: StarterError) => e.kind === 'profile_not_found');
});

test('a {status:"error"} launch envelope with HTTP 200 is treated as a failure', async () => {
  await assert.rejects(launch(CONFLICT_ID), (e: StarterError) => e.kind === 'profile_busy' && /exited 21/.test(e.message));
});

test('an unreachable API maps to api_unreachable with a hint', async () => {
  const closed = createApi({ apiPort: 1, apiTimeoutSeconds: 2, launchTimeoutMs: 5000 });
  await assert.rejects(launchProfile(closed, READY_ID, { headless: true, deadline: Date.now() + 2000 }), (e: StarterError) => e.kind === 'api_unreachable' && Boolean(e.hint));
});

test('shutdown falls back to profile.stop() when the browser does not exit, and says so', async () => {
  const report = await shutdownOwnedProfile(api, STUCK_ID, async () => undefined, { stopTimeoutMs: 5000, graceMs: 300 });
  assert.equal(report.method, 'api-stop');
  assert.equal(report.ok, true);
  assert.equal(report.finalStatus, 'Ready');
  assert.match(report.warnings.join(' '), /terminates the process/);
});

test('shutdown of an already-stopped profile is graceful and quick', async () => {
  const report = await shutdownOwnedProfile(api, READY_ID, async () => undefined, { stopTimeoutMs: 5000 });
  assert.equal(report.method, 'graceful');
  assert.equal(report.ok, true);
});
