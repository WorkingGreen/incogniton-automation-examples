/**
 * Puppeteer session helper for Incogniton profiles (repository helper, not an SDK method).
 *
 * Differences from Playwright that matter here:
 * - `browser.newPage()` opens a tab in the DEFAULT (persistent) context in Puppeteer.
 *   `browser.createBrowserContext()` is the isolated, non-persistent variant.
 * - `browser.close()` on a connected browser sends CDP `Browser.close`, i.e. it really
 *   closes Chrome (graceful). `browser.disconnect()` leaves it running.
 * - `defaultViewport: null` keeps the profile's real window size instead of Puppeteer's
 *   800x600 emulation, so the viewport matches the profile's configured screen.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { StarterConfig } from './config.js';
import { StarterError } from './errors.js';
import { createApi, launchProfile, shutdownOwnedProfile, silentLog, type CleanupReport, type IncognitonApi, type Log } from './incogniton.js';
import { acquireProfileLock } from './profile-lock.js';

export interface PuppeteerSession {
  profileId: string;
  cdpUrl: string;
  browserVersion: string;
  browser: Browser;
  page: Page;
  owned: true;
  close(): Promise<CleanupReport>;
}

async function connectPuppeteer(cdpUrl: string, deadline: number, log: Log): Promise<Browser> {
  let attempt = 0;
  let lastError: unknown;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      return await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null, protocolTimeout: 30000 });
    } catch (error) {
      lastError = error;
      log(`puppeteer.connect attempt ${attempt} failed: ${(error as Error).message.split('\n')[0]}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new StarterError('connect_failed', `Could not connect Puppeteer to ${cdpUrl}: ${(lastError as Error | undefined)?.message ?? 'deadline reached'}`, { cause: lastError });
}

export async function openPuppeteerSession(
  config: StarterConfig,
  options: { profileId: string; log?: Log; signal?: AbortSignal; api?: IncognitonApi },
): Promise<PuppeteerSession> {
  const log = options.log ?? silentLog;
  const api = options.api ?? createApi(config);
  const lock = acquireProfileLock(options.profileId, 'puppeteer-session');
  const deadline = Date.now() + config.launchTimeoutMs;
  let launched;
  try {
    launched = await launchProfile(api, options.profileId, { headless: config.headless, deadline, log, signal: options.signal });
  } catch (error) {
    lock.release();
    throw error;
  }
  log(`profile started in ${launched.launchMs} ms (${launched.browserVersion}); connecting Puppeteer`);
  let browser: Browser | undefined;
  try {
    browser = await connectPuppeteer(launched.cdpUrl, deadline, log);
    const page = await browser.newPage(); // default context = the profile's persistent storage
    page.setDefaultTimeout(config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(config.actionTimeoutMs);
    const connected = browser;
    let closing: Promise<CleanupReport> | undefined;
    const session: PuppeteerSession = {
      profileId: options.profileId,
      cdpUrl: launched.cdpUrl,
      browserVersion: launched.browserVersion,
      browser: connected,
      page,
      owned: true,
      close() {
        closing ??= (async () => {
          log('closing the browser (Puppeteer browser.close sends Browser.close) and waiting for the app stop/sync pipeline');
          const report = await shutdownOwnedProfile(
            api,
            options.profileId,
            async () => {
              // Close our tab first: Chrome restores open tabs on the next launch.
              await page.close().catch(() => undefined);
              await connected.close().catch(() => undefined);
            },
            { stopTimeoutMs: config.stopTimeoutMs, log },
          );
          lock.release();
          return report;
        })();
        return closing;
      },
    };
    if (options.signal?.aborted) {
      await session.close();
      throw options.signal.reason;
    }
    return session;
  } catch (error) {
    if (options.signal?.aborted && error === options.signal.reason) throw error;
    await browser?.close().catch(() => undefined);
    await shutdownOwnedProfile(api, options.profileId, async () => undefined, { stopTimeoutMs: config.stopTimeoutMs, graceMs: 5000, log });
    lock.release();
    throw error;
  }
}
