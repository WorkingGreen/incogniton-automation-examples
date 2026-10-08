// Wait for delayed iframes, interact inside a same-origin and a cross-origin frame,
// and verify results inside the frames and in the parent page.
// Run: npm run example:iframe
import { requireProfileId } from '../../lib/config.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { check, runExample } from '../../lib/run.js';

await runExample(
  { id: 'interact-with-iframe', framework: 'playwright', description: 'Interact with same-origin and cross-origin iframes.' },
  {},
  async ({ config, artifact, manage, onCleanup, log, signal }) => {
    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());
    const { page } = manage(await openPlaywrightSession(config, { profileId: requireProfileId(config), log, signal }));

    await page.goto(fixtures.url(`iframe.html?crossPort=${config.fixtureCrossOriginPort}`));

    // frameLocator() selects the frame by its <iframe> element and waits for it to appear.
    // Locators inside it are scoped to the frame's document, not the parent page.
    const counter = page.frameLocator('iframe[title="Counter frame"]');
    const increment = counter.getByRole('button', { name: 'Increment' });
    await increment.click(); // auto-waits until the button is enabled inside the frame
    await increment.click();
    await counter.getByRole('status').filter({ hasText: 'Count: 2' }).waitFor();

    // Cross-origin frame (different port = different origin). Playwright drives it the same
    // way: it attaches to out-of-process frames, so no same-origin access is needed.
    const messageFrame = page.frameLocator('iframe[title="Message frame"]');
    await messageFrame.getByLabel('Message').fill('hello from Incogniton');
    await messageFrame.getByRole('button', { name: 'Send to parent' }).click();
    await messageFrame.getByRole('status').filter({ hasText: 'Sent: hello from Incogniton' }).waitFor();

    // The frame posted a message to the parent: verify the parent page reacted.
    const parentStatus = page.locator('#parent-status');
    await parentStatus.filter({ hasText: 'Parent received: hello from Incogniton' }).waitFor();

    // Frame objects expose URLs/origins; useful when deciding which frame you are in.
    const crossFrame = page.frames().find((frame) => frame.url().startsWith(fixtures.crossOrigin));
    check(crossFrame !== undefined, 'cross-origin frame not found in page.frames()');
    // Coordinates are always page (viewport) coordinates, even for elements inside frames.
    const box = await messageFrame.getByRole('button', { name: 'Send to parent' }).boundingBox();
    await page.screenshot({ path: artifact('iframes.png'), fullPage: true });

    return {
      summary: 'Clicked inside the same-origin frame (Count: 2) and sent a message from the cross-origin frame to the parent.',
      details: { crossOriginFrameUrl: crossFrame.url().split('?')[0], sendButtonPageBox: box },
    };
  },
);
