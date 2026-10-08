// Launch an Incogniton profile, connect Puppeteer, take a verified screenshot, stop the profile.
// Self-contained: uses only the official `incogniton` SDK, puppeteer-core and Node built-ins.
// Run: npm run example:puppeteer:screenshot   (or add --profile-id <id>)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync } from 'node:fs';
import { IncognitonClient } from 'incogniton';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

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

const fixture = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<title>Incogniton fixture</title><h1>Incogniton automation fixture</h1><p role="status" id="s">Loading…</p>
    <script>setTimeout(() => { document.getElementById('s').textContent = 'Fixture ready'; }, 300)</script>`);
});
await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const FIXTURE_URL = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;

const client = new IncognitonClient(`http://127.0.0.1:${API_PORT}`, 120); // timeout in seconds
let launched = false;
let browser: Browser | undefined;
let page: Page | undefined;
try {
  // 1. Only launch a profile that is not already open.
  const { status } = (await client.profile.getStatus(PROFILE_ID)) as { status: string };
  if (status !== 'Ready') throw new Error(`Profile status is "${status}", expected "Ready". Close it in the Incogniton app first.`);

  // 2. Launch for CDP automation and check the response envelope ({status:"error"} arrives with HTTP 200).
  const launch = (await client.automation.launchPuppeteerCustom(PROFILE_ID, HEADLESS ? '--headless=new' : '')) as {
    status: string; puppeteerUrl?: string; message?: string;
  };
  if (launch.status !== 'ok' || !launch.puppeteerUrl) throw new Error(`Launch failed: ${launch.message ?? launch.status}`);
  launched = true;

  // 3. Connect. defaultViewport: null keeps the profile's real window size (no 800x600 emulation).
  browser = await puppeteer.connect({ browserURL: launch.puppeteerUrl, defaultViewport: null });

  // 4. In Puppeteer, browser.newPage() opens a tab in the default context, which holds the profile's
  //    persistent cookies and storage. (browser.createBrowserContext() would be isolated and empty.)
  page = await browser.newPage();
  await page.goto(FIXTURE_URL);
  await page.waitForFunction(() => document.getElementById('s')?.textContent === 'Fixture ready', { timeout: 15_000 });

  // 5. Verify and save evidence.
  const heading = await page.$eval('h1', (el) => el.textContent);
  if (heading !== 'Incogniton automation fixture') throw new Error(`Unexpected heading: ${heading}`);
  const dir = `output/puppeteer-launch-profile-and-screenshot/${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/screenshot.png`, fullPage: true });
  console.log(`PASS: ${await browser.version()} rendered the fixture; screenshot saved to ${dir}/screenshot.png`);
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  // 6. Cleanup. Puppeteer's browser.close() sends Browser.close: Chrome flushes storage and the app
  //    runs its stop/sync pipeline. Wait for "Ready"; fall back to profile.stop() (process termination).
  if (launched) {
    await page?.close().catch(() => undefined); // Chrome restores open tabs next launch; don't leave ours
    await browser?.close().catch(() => undefined);
    let status = '';
    for (let i = 0; i < 120 && status !== 'Ready'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = ((await client.profile.getStatus(PROFILE_ID)) as { status: string }).status;
      if (i === 40 && status === 'Launched') await client.profile.stop(PROFILE_ID);
    }
    console.log(`Profile status after cleanup: ${status}`);
  }
  fixture.close();
}
