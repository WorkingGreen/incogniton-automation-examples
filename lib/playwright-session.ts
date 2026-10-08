/**
 * Playwright session helpers for Incogniton profiles (repository helpers, not SDK methods).
 *
 * Persistence rule: the profile's cookies, localStorage and IndexedDB live in
 * the browser's DEFAULT context, `browser.contexts()[0]`. Create pages with
 * `context.newPage()` on that context. `browser.newPage()` and
 * `browser.newContext()` create a fresh, empty context whose data is discarded.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { StarterConfig } from './config.js';
import { StarterError } from './errors.js';
import {
  createApi,
  launchProfile,
  shutdownOwnedProfile,
  silentLog,
  type CleanupReport,
  type IncognitonApi,
  type Log,
} from './incogniton.js';
import { acquireProfileLock } from './profile-lock.js';

export interface PlaywrightSession {
  profileId: string;
  cdpUrl: string;
  browserVersion: string;
  browser: Browser;
  /** The profile's persistent default context. */
  context: BrowserContext;
  /** A new tab in the persistent context, owned by this run. */
  page: Page;
  /** true when this process launched the profile and is responsible for stopping it. */
  owned: boolean;
  /** Idempotent. Owned: graceful close + wait for Ready. Attached: disconnect only. */
  close(): Promise<CleanupReport>;
}

/**
 * Connects Playwright to a CDP endpoint with bounded attempts. Connecting is
 * read-only, so retrying it is safe (unlike launching or creating profiles).
 */
export async function connectPlaywright(cdpUrl: string, deadline: number, log: Log = silentLog): Promise<Browser> {
  let attempt = 0;
  let lastError: unknown;
  while (Date.now() < deadline) {
    attempt += 1;
    const timeout = Math.max(1000, Math.min(15000, deadline - Date.now()));
    try {
      return await chromium.connectOverCDP(cdpUrl, { timeout });
    } catch (error) {
      lastError = error;
      log(`connectOverCDP attempt ${attempt} failed: ${(error as Error).message.split('\n')[0]}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new StarterError('connect_failed', `Could not connect Playwright to ${cdpUrl} after ${attempt} attempt(s): ${(lastError as Error | undefined)?.message?.split('\n')[0] ?? 'deadline reached'}`, {
    cause: lastError,
  });
}

function defaultContext(browser: Browser): BrowserContext {
  const context = browser.contexts()[0];
  if (!context) throw new StarterError('connect_failed', 'Connected, but the browser exposes no default context.');
  return context;
}

/** Launches `profileId` through the Incogniton API and connects Playwright to it. */
export async function openPlaywrightSession(
  config: StarterConfig,
  options: { profileId: string; log?: Log; signal?: AbortSignal; api?: IncognitonApi; customArgs?: string },
): Promise<PlaywrightSession> {
  const log = options.log ?? silentLog;
  const api = options.api ?? createApi(config);
  const lock = acquireProfileLock(options.profileId, 'playwright-session');
  const deadline = Date.now() + config.launchTimeoutMs;
  let launched;
  try {
    launched = await launchProfile(api, options.profileId, {
      headless: config.headless,
      customArgs: options.customArgs,
      deadline,
      log,
      signal: options.signal,
    });
  } catch (error) {
    lock.release();
    throw error;
  }
  log(`profile started in ${launched.launchMs} ms (${launched.browserVersion}); connecting Playwright`);

  let browser: Browser | undefined;
  try {
    browser = await connectPlaywright(launched.cdpUrl, deadline, log);
    const context = defaultContext(browser);
    context.setDefaultTimeout(config.actionTimeoutMs);
    context.setDefaultNavigationTimeout(config.actionTimeoutMs);
    const page = await context.newPage();
    const connected = browser;
    let closing: Promise<CleanupReport> | undefined;
    const session: PlaywrightSession = {
      profileId: options.profileId,
      cdpUrl: launched.cdpUrl,
      browserVersion: launched.browserVersion,
      browser: connected,
      context,
      page,
      owned: true,
      close() {
        closing ??= (async () => {
          log('closing the browser gracefully and waiting for the app to finish its stop/sync pipeline');
          const report = await shutdownOwnedProfile(
            api,
            options.profileId,
            async () => {
              // Close the tab this run opened first. Chrome restores open tabs on the next
              // launch, so leaving it open would accumulate tabs run after run.
              await page.close().catch(() => undefined);
              const cdp = await connected.newBrowserCDPSession();
              // Browser.close lets Chrome flush storage. The connection drops
              // while the request is in flight, so its rejection is expected.
              await cdp.send('Browser.close').catch(() => undefined);
            },
            { stopTimeoutMs: config.stopTimeoutMs, log },
          );
          await connected.close().catch(() => undefined); // releases the client-side connection
          lock.release();
          return report;
        })();
        return closing;
      },
    };
    if (options.signal?.aborted) {
      // Cancelled while launching: do not hand out a session nobody will clean up.
      await session.close();
      throw options.signal.reason;
    }
    return session;
  } catch (error) {
    if (options.signal?.aborted && error === options.signal.reason) throw error;
    // Launched but not usable: stop what we started, keep the original error.
    await browser?.close().catch(() => undefined);
    await shutdownOwnedProfile(api, options.profileId, async () => undefined, { stopTimeoutMs: config.stopTimeoutMs, graceMs: 0, log });
    lock.release();
    throw error;
  }
}

/**
 * Attaches to a browser that is already running (for example one started by
 * `npm run session -- start`). close() only disconnects: the browser keeps running.
 */
export async function attachPlaywrightSession(
  config: StarterConfig,
  options: { profileId: string; cdpUrl: string; log?: Log },
): Promise<PlaywrightSession> {
  const browser = await connectPlaywright(options.cdpUrl, Date.now() + Math.min(config.launchTimeoutMs, 30000), options.log);
  const context = defaultContext(browser);
  context.setDefaultTimeout(config.actionTimeoutMs);
  context.setDefaultNavigationTimeout(config.actionTimeoutMs);
  const page = await context.newPage();
  let closing: Promise<CleanupReport> | undefined;
  return {
    profileId: options.profileId,
    cdpUrl: options.cdpUrl,
    browserVersion: browser.version(),
    browser,
    context,
    page,
    owned: false,
    close() {
      closing ??= (async () => {
        const started = Date.now();
        await page.close().catch(() => undefined); // remove only the tab this run opened
        // Playwright's close() on a connectOverCDP browser disconnects; it does not close Chrome.
        await browser.close().catch(() => undefined);
        return { profileId: options.profileId, method: 'detached', ok: true, sawSyncStatus: false, durationMs: Date.now() - started, warnings: [] };
      })();
      return closing;
    },
  };
}
