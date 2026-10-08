// Launch an Incogniton profile, connect Playwright, take a verified screenshot, stop the profile.
// Self-contained: uses only the official `incogniton` SDK, playwright-core and Node built-ins.
// Run: npm run example:screenshot   (or: npx tsx examples/playwright/launch-profile-and-screenshot.ts --profile-id <id>)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync } from 'node:fs';
import { IncognitonClient } from 'incogniton';
import { chromium, type Browser, type Page } from 'playwright-core';

try { process.loadEnvFile('.env'); } catch { /* .env is optional; environment variables also work */ }
const argIndex = process.argv.indexOf('--profile-id');
const PROFILE_ID = argIndex > 0 ? process.argv[argIndex + 1] : process.env.INCOGNITON_PROFILE_ID;
const portIndex = process.argv.indexOf('--port');
const API_PORT = Number(portIndex > 0 ? process.argv[portIndex + 1] : process.env.INCOGNITON_API_PORT ?? 35000);
const HEADLESS = process.argv.includes('--headed') ? false : process.env.INCOGNITON_HEADLESS !== 'false';
if (!PROFILE_ID) {
  console.error('Set INCOGNITON_PROFILE_ID in .env (npm run setup) or pass --profile-id <id>.');
  process.exit(2);
}

// A tiny local page that becomes "ready" after a delay, so we wait for real content.
const fixture = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<title>Incogniton fixture</title><h1>Incogniton automation fixture</h1><p role="status" id="s">Loading…</p>
    <script>setTimeout(() => { document.getElementById('s').textContent = 'Fixture ready'; }, 300)</script>`);
});
await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve)); // any free port
const FIXTURE_URL = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;

// SDK client for the local Incogniton API. Second argument: request timeout in seconds
// (launch requests block until the browser has started).
const client = new IncognitonClient(`http://127.0.0.1:${API_PORT}`, 120);
let launched = false;
let browser: Browser | undefined;
let page: Page | undefined;
try {
  // 1. Only launch a profile that is not already open (a second launch fails).
  const { status } = (await client.profile.getStatus(PROFILE_ID)) as { status: string };
  if (status !== 'Ready') throw new Error(`Profile status is "${status}", expected "Ready". Close it in the Incogniton app first.`);

  // 2. Launch the profile for CDP automation. The response envelope must be checked:
  //    errors arrive as {status: "error", message} with HTTP 200.
  const launch = (await client.automation.launchPuppeteerCustom(PROFILE_ID, HEADLESS ? '--headless=new' : '')) as {
    status: string; puppeteerUrl?: string; message?: string;
  };
  if (launch.status !== 'ok' || !launch.puppeteerUrl) throw new Error(`Launch failed: ${launch.message ?? launch.status}`);
  launched = true;

  // 3. Connect Playwright over CDP. Bounded attempts: right after launch, restored tabs can still be loading.
  for (let attempt = 1; !browser; attempt++) {
    try {
      browser = await chromium.connectOverCDP(launch.puppeteerUrl, { timeout: 10_000 });
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }

  // 4. Use the profile's persistent DEFAULT context. browser.newPage()/newContext() would create
  //    a fresh, empty context without the profile's cookies and storage.
  const context = browser.contexts()[0];
  page = await context.newPage();
  await page.goto(FIXTURE_URL);
  await page.getByRole('status').filter({ hasText: 'Fixture ready' }).waitFor({ timeout: 15_000 });

  // 5. Verify and save evidence.
  const heading = await page.getByRole('heading', { level: 1 }).textContent();
  if (heading !== 'Incogniton automation fixture') throw new Error(`Unexpected heading: ${heading}`);
  const dir = `output/launch-profile-and-screenshot/${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/screenshot.png`, fullPage: true });
  console.log(`PASS: ${browser.version()} rendered the fixture; screenshot saved to ${dir}/screenshot.png`);
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  // 6. Cleanup. Closing the browser over CDP lets Chrome flush cookies/storage and the app
  //    run its stop/sync pipeline. profile.stop() is the fallback; it terminates the process.
  if (launched) {
    await page?.close().catch(() => undefined); // Chrome restores open tabs next launch; don't leave ours
    await browser?.newBrowserCDPSession().then((cdp) => cdp.send('Browser.close')).catch(() => undefined);
    let status = '';
    for (let i = 0; i < 120 && status !== 'Ready'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = ((await client.profile.getStatus(PROFILE_ID)) as { status: string }).status;
      if (i === 40 && status === 'Launched') await client.profile.stop(PROFILE_ID);
    }
    console.log(`Profile status after cleanup: ${status}`);
  }
  await browser?.close().catch(() => undefined);
  fixture.close();
}
