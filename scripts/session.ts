// Start a long-lived profile browser that other processes can attach to, list such sessions,
// or stop one gracefully.
//   npm run session -- start [--profile-id <id>] [--headed]
//   npm run session -- list
//   npm run session -- stop  [--profile-id <id>]
// Incogniton's API does not return the CDP endpoint of a profile that is already open, so
// attaching is only possible to a browser whose endpoint was recorded when it was launched.
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { flagOverrides, loadConfig, requireProfileId } from '../lib/config.js';
import { EXIT_CODES, failureKindOf } from '../lib/errors.js';
import { createApi, getProfileStatus, launchProfile, shutdownOwnedProfile } from '../lib/incogniton.js';
import { reportFatal } from '../lib/run.js';
import { isCdpAlive, listSessionRecords, readSessionRecord, removeSessionRecord, writeSessionRecord } from '../lib/state.js';

const { values, positionals } = parseArgs({
  options: { 'profile-id': { type: 'string' }, headed: { type: 'boolean' }, headless: { type: 'boolean' }, port: { type: 'string' } },
  allowPositionals: true,
});
const command = positionals[0] ?? 'list';

try {
  const config = loadConfig(flagOverrides(values));
  const api = createApi(config);
  const log = (message: string) => console.log(`[session] ${message}`);

  if (command === 'start') {
    const profileId = requireProfileId(config);
    const launched = await launchProfile(api, profileId, { headless: config.headless, deadline: Date.now() + config.launchTimeoutMs, log });
    const path = writeSessionRecord({ profileId, cdpUrl: launched.cdpUrl, browserVersion: launched.browserVersion, headless: config.headless, startedAt: new Date().toISOString() });
    console.log(`Started ${profileId} (${launched.browserVersion}); CDP endpoint ${launched.cdpUrl}`);
    console.log(`Session record: ${path}`);
    console.log('The browser keeps running after this command exits. Attach with: npm run example:attach');
    console.log('Stop it with: npm run session -- stop');
  } else if (command === 'list') {
    const records = listSessionRecords();
    if (records.length === 0) console.log('No recorded sessions.');
    for (const record of records) {
      const alive = await isCdpAlive(record.cdpUrl);
      const status = await getProfileStatus(api, record.profileId).catch((error: Error) => `unknown (${error.message})`);
      console.log(`${record.profileId}  ${record.cdpUrl}  cdp=${alive ? 'alive' : 'gone'}  status=${status}  started=${record.startedAt}`);
    }
  } else if (command === 'stop') {
    const profileId = requireProfileId(config);
    const record = readSessionRecord(profileId);
    if (!record) {
      // Only stop browsers this starter launched; never someone's manually opened profile.
      console.error(`No session record for ${profileId}; refusing to stop a browser this starter did not start.`);
      process.exitCode = EXIT_CODES.config_invalid;
    } else {
      const alive = await isCdpAlive(record.cdpUrl);
      const report = await shutdownOwnedProfile(
        api,
        profileId,
        async () => {
          if (!alive) return;
          const browser = await chromium.connectOverCDP(record.cdpUrl, { timeout: 15000 });
          const cdp = await browser.newBrowserCDPSession();
          await cdp.send('Browser.close').catch(() => undefined);
          await browser.close().catch(() => undefined);
        },
        { stopTimeoutMs: config.stopTimeoutMs, log },
      );
      removeSessionRecord(profileId);
      console.log(`Stop ${report.ok ? 'completed' : 'FAILED'} via ${report.method}; final status ${report.finalStatus ?? 'unknown'}${report.error ? ` (${report.error})` : ''}`);
      for (const warning of report.warnings) console.log(`warning: ${warning}`);
      process.exitCode = report.ok ? 0 : EXIT_CODES.cleanup_failed;
    }
  } else {
    console.error(`Unknown command "${command}". Use start, list or stop.`);
    process.exitCode = EXIT_CODES.config_invalid;
  }
} catch (error) {
  reportFatal('session', error);
  process.exitCode = EXIT_CODES[failureKindOf(error)];
}
