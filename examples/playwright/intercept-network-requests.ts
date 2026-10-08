// Observe, mock and block network requests from an Incogniton profile with page.route():
// replace an API response with a fixture value and block a tracking pixel.
// Run: npm run example:network
import { requireProfileId } from '../../lib/config.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { check, runExample } from '../../lib/run.js';

await runExample(
  { id: 'intercept-network-requests', framework: 'playwright', description: 'Mock an API response and block a request in an Incogniton profile.' },
  {},
  async ({ config, artifact, manage, onCleanup, log, signal }) => {
    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());
    const { page } = manage(await openPlaywrightSession(config, { profileId: requireProfileId(config), log, signal }));

    const seen: string[] = [];
    page.on('request', (request) => seen.push(new URL(request.url()).pathname));

    // Routes are registered on this page only; other tabs of the profile are unaffected.
    await page.route('**/api/quote', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'Mocked by the example', source: 'page.route' }) }),
    );
    await page.route('**/pixel.gif', (route) => route.abort('blockedbyclient'));

    await page.goto(fixtures.url('network.html'));
    await page.getByRole('status').filter({ hasText: 'Quote: Mocked by the example (source: page.route)' }).waitFor();
    await page.locator('#pixel-status').filter({ hasText: 'Pixel blocked' }).waitFor();
    await page.screenshot({ path: artifact('network.png') });

    check(seen.includes('/api/quote') && seen.includes('/pixel.gif'), `expected both requests to be observed, saw ${seen.join(', ')}`);
    return { summary: 'Mocked /api/quote and blocked /pixel.gif; the page showed the mocked quote and the blocked pixel.', details: { requestsSeen: seen } };
  },
);
