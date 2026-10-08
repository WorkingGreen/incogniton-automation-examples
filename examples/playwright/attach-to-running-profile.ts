// Attach Playwright to an Incogniton profile browser that is already running, do some work,
// and leave the browser running (the default). The browser must have been started with
// `npm run session -- start`, which records its CDP endpoint; the Incogniton API does not
// return the endpoint of a profile that is already open (see docs/lifecycle-and-persistence.md).
// Run: npm run session -- start   then   npm run example:attach   then   npm run session -- stop
import { StarterError } from '../../lib/errors.js';
import { requireProfileId } from '../../lib/config.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { createApi, getProfileStatus } from '../../lib/incogniton.js';
import { attachPlaywrightSession } from '../../lib/playwright-session.js';
import { check, runExample } from '../../lib/run.js';
import { isCdpAlive, readSessionRecord } from '../../lib/state.js';

await runExample(
  { id: 'attach-to-running-profile', framework: 'playwright', description: 'Attach to a running profile browser without stopping it.' },
  { 'cdp-url': { type: 'string' } },
  async ({ config, flags, artifact, manage, onCleanup, log }) => {
    const profileId = requireProfileId(config);
    const cdpUrl = flags['cdp-url'] ? String(flags['cdp-url']) : readSessionRecord(profileId)?.cdpUrl;
    if (!cdpUrl) {
      throw new StarterError('config_invalid', `No recorded session for profile ${profileId}.`, {
        hint: 'Start one with `npm run session -- start`, or pass --cdp-url http://127.0.0.1:<port> from your own launcher.',
      });
    }
    if (!(await isCdpAlive(cdpUrl))) {
      throw new StarterError('connect_failed', `Nothing answers at ${cdpUrl}; the recorded browser is no longer running.`, {
        hint: 'Run `npm run session -- stop` to clear the record, then `npm run session -- start`.',
      });
    }
    const api = createApi(config);
    log(`profile status before attaching: ${await getProfileStatus(api, profileId)}`);

    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());
    // Attach: connect only, no launch. close() later disconnects and closes just our tab.
    const session = manage(await attachPlaywrightSession(config, { profileId, cdpUrl, log }));
    const existingTabs = session.context.pages().length - 1; // minus the tab we just opened
    await session.page.goto(fixtures.url('index.html'));
    await session.page.getByRole('status').filter({ hasText: 'Fixture ready' }).waitFor();
    await session.page.screenshot({ path: artifact('attached.png') });

    const report = await session.close(); // detach: the browser keeps running
    check(report.method === 'detached', 'attached session should only detach');
    const stillAlive = await isCdpAlive(cdpUrl);
    const statusAfter = await getProfileStatus(api, profileId);
    check(stillAlive, 'the browser stopped after detaching; it should keep running');

    return {
      summary: `Attached to ${cdpUrl}, rendered the fixture in a new tab, detached. Browser still running (status ${statusAfter}).`,
      details: { cdpUrl, existingTabs, browserStillRunning: stillAlive, statusAfter },
    };
  },
);
