/**
 * Framework-neutral Incogniton lifecycle helpers built on the published
 * `incogniton` npm SDK (IncognitonClient).
 *
 * These functions are repository helpers, NOT Incogniton SDK methods. The SDK
 * calls they make are marked "SDK:" so it is clear which part is official.
 *
 * Runtime-verified behaviour they encode (see docs/lifecycle-and-persistence.md):
 * - `client.automation.launchPuppeteerCustom()` returns `{status:'ok', puppeteerUrl}`
 *   or `{status:'error', message}` with HTTP 200, so the envelope must be checked.
 * - Launching a profile that is already open fails (it does not return the
 *   existing CDP endpoint), so the profile status is checked first.
 * - `client.profile.stop()` terminates the browser process. Cookies/localStorage
 *   written in the last ~30 s can be lost. Closing the browser over CDP
 *   (`Browser.close`) lets Chrome flush its storage and the app then runs its
 *   normal stop/sync pipeline (status Syncing -> Ready).
 */
import { IncognitonClient } from 'incogniton';
import type { StarterConfig } from './config.js';
import { StarterError, classifyLaunchMessage, fromSdkError, sanitize } from './errors.js';

export type Log = (message: string) => void;
export const silentLog: Log = () => {};

/** Observed `/profile/status/{id}` values (wire format, capitalised). */
export const READY = 'Ready';
const OPEN_STATUSES = new Set(['Launched', 'Launching', 'Opened', 'Launched on different device']);
const TRANSIENT_STATUSES = new Set(['Syncing', 'Stopping', 'Uploading', 'Checking proxy', 'Adding']);

export interface IncognitonApi {
  port: number;
  /** SDK client for ordinary requests (short timeout). */
  client: IncognitonClient;
  /** SDK client for launch requests, which block until the browser started. */
  launchClient: IncognitonClient;
}

export function createApi(config: Pick<StarterConfig, 'apiPort' | 'apiTimeoutSeconds' | 'launchTimeoutMs'>): IncognitonApi {
  const baseUrl = `http://127.0.0.1:${config.apiPort}`;
  return {
    port: config.apiPort,
    // SDK: new IncognitonClient(baseUrl, timeoutSeconds)
    client: new IncognitonClient(baseUrl, config.apiTimeoutSeconds),
    launchClient: new IncognitonClient(baseUrl, Math.ceil(config.launchTimeoutMs / 1000)),
  };
}

/**
 * Health probe for GET /alive. The published 1.0.x npm SDK has no
 * `system.alive()` method, so this uses fetch directly.
 */
export async function checkAlive(port: number, timeoutMs = 5000): Promise<{ ok: boolean; body?: string; error?: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/alive`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await response.text()).trim().replace(/^"|"$/g, '');
    return { ok: response.ok && body === 'OK', body };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return { ok: false, error: cause?.code ?? (error as Error).message };
  }
}

export async function getProfileStatus(api: IncognitonApi, profileId: string): Promise<string> {
  let response: { status?: string; message?: string };
  try {
    // SDK: client.profile.getStatus(id). The wire value is e.g. "Ready" or "Launched";
    // an unknown ID returns {status:"error", message:"No profile found ..."}.
    response = (await api.client.profile.getStatus(profileId)) as { status?: string; message?: string };
  } catch (error) {
    throw fromSdkError(error, 'Reading profile status', api.port);
  }
  if (response.status === 'error') {
    const message = response.message ?? 'unknown error';
    const { kind, hint } = classifyLaunchMessage(message);
    throw new StarterError(kind === 'launch_failed' ? 'api_error' : kind, `Profile ${profileId}: ${sanitize(message)}`, { hint });
  }
  return response.status ?? 'unknown';
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

/** Waits (bounded) until the profile is Ready; fails fast if it is open elsewhere. */
export async function waitUntilReady(api: IncognitonApi, profileId: string, deadline: number, log: Log, signal?: AbortSignal): Promise<void> {
  let lastLogged = '';
  for (;;) {
    const status = await getProfileStatus(api, profileId);
    if (status === READY) return;
    if (OPEN_STATUSES.has(status)) {
      throw new StarterError('profile_busy', `Profile ${profileId} is already open (status "${status}").`, {
        hint: 'Close the profile in the Incogniton app (or stop the session that opened it) and retry. This starter never takes over a browser it did not launch.',
      });
    }
    if (!TRANSIENT_STATUSES.has(status)) {
      throw new StarterError('launch_failed', `Profile ${profileId} is not launchable (status "${status}").`);
    }
    if (status !== lastLogged) log(`profile status is "${status}"; waiting for Ready`);
    lastLogged = status;
    if (Date.now() >= deadline) {
      throw new StarterError('timeout', `Profile ${profileId} stayed "${status}" until the launch deadline.`, {
        hint: 'A previous run may still be syncing. Increase INCOGNITON_LAUNCH_TIMEOUT_MS or wait and retry.',
      });
    }
    await sleep(500, signal);
  }
}

export interface LaunchedProfile {
  profileId: string;
  /** HTTP DevTools endpoint, e.g. http://127.0.0.1:61370 */
  cdpUrl: string;
  /** Browser product reported by the DevTools endpoint, e.g. Chrome/152.0.7977.54 */
  browserVersion: string;
  launchMs: number;
}

/**
 * Launches a profile for CDP automation and waits until its DevTools endpoint
 * answers and restored tabs have settled. If anything fails after the browser
 * started, the browser is stopped before the error is rethrown.
 */
export async function launchProfile(
  api: IncognitonApi,
  profileId: string,
  options: { headless: boolean; customArgs?: string; deadline: number; log?: Log; signal?: AbortSignal },
): Promise<LaunchedProfile> {
  const log = options.log ?? silentLog;
  const started = Date.now();
  await waitUntilReady(api, profileId, options.deadline, log, options.signal);

  const args = [options.headless ? '--headless=new' : '', options.customArgs ?? ''].filter(Boolean).join(' ');
  log(`launching profile ${profileId}${options.headless ? ' (headless)' : ' (headed)'}`);
  let response: { status?: string; message?: string; puppeteerUrl?: string };
  try {
    // SDK: client.automation.launchPuppeteerCustom(profileId, customArgs)
    // -> POST /automation/launch/puppeteer {profileID, customArgs}. Despite the
    // name, the returned puppeteerUrl is a plain CDP endpoint usable by
    // Playwright, Puppeteer or any CDP client.
    response = (await api.launchClient.automation.launchPuppeteerCustom(profileId, args)) as typeof response;
  } catch (error) {
    throw fromSdkError(error, 'Launching profile', api.port);
  }
  if (response.status !== 'ok' || !response.puppeteerUrl) {
    const message = response.message ?? `unexpected launch response (status=${String(response.status)})`;
    const { kind, hint } = classifyLaunchMessage(message);
    throw new StarterError(kind, `Launch of profile ${profileId} failed: ${sanitize(message)}`, { hint });
  }
  const cdpUrl = response.puppeteerUrl.replace(/\/$/, '');
  try {
    const version = await waitForCdp(cdpUrl, options.deadline, options.signal);
    await waitForSettledTabs(cdpUrl, Math.min(options.deadline, Date.now() + 8000), options.signal);
    return { profileId, cdpUrl, browserVersion: version.Browser ?? 'unknown', launchMs: Date.now() - started };
  } catch (error) {
    log('browser did not become ready; stopping it');
    await api.client.profile.stop(profileId).catch(() => undefined);
    throw error;
  }
}

/** Polls GET <cdpUrl>/json/version until the DevTools endpoint answers. */
export async function waitForCdp(cdpUrl: string, deadline: number, signal?: AbortSignal): Promise<{ Browser?: string; webSocketDebuggerUrl?: string }> {
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return (await response.json()) as { Browser?: string };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
    }
    await sleep(200, signal);
  }
  throw new StarterError('connect_failed', `DevTools endpoint ${cdpUrl} did not answer before the deadline (${lastError}).`);
}

/**
 * Waits briefly until every page target reports a URL and the list is stable.
 * Connecting while a restored tab is still committing its first navigation can
 * make Playwright's connectOverCDP hang until its timeout (observed with
 * Playwright 1.64 and Chrome 152), so this narrows that window.
 */
async function waitForSettledTabs(cdpUrl: string, deadline: number, signal?: AbortSignal): Promise<void> {
  let previous = '';
  while (Date.now() < deadline) {
    try {
      const targets = (await (await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(2000) })).json()) as Array<{ type: string; url: string }>;
      const pages = targets.filter((target) => target.type === 'page');
      const snapshot = JSON.stringify(pages.map((page) => page.url));
      if (pages.every((page) => page.url !== '') && snapshot === previous) return;
      previous = snapshot;
    } catch {
      previous = '';
    }
    await sleep(250, signal);
  }
}

export interface CleanupReport {
  profileId: string;
  /** graceful: browser closed over CDP; api-stop: profile.stop(); mcp-stop: MCP stop_profile; detached: left running; none: nothing to do */
  method: 'graceful' | 'api-stop' | 'mcp-stop' | 'detached' | 'none';
  ok: boolean;
  /** True when the app reported Syncing/Stopping/Uploading during shutdown. */
  sawSyncStatus: boolean;
  finalStatus?: string;
  durationMs: number;
  warnings: string[];
  error?: string;
}

/**
 * Stops a profile this process launched.
 *
 * 1. `requestGracefulClose` closes the browser over CDP so Chrome flushes
 *    cookies/localStorage; the app then runs its stop/sync pipeline.
 * 2. If the browser is still reported as running after a grace period, falls
 *    back to SDK `client.profile.stop()` (process termination) and says so.
 * 3. Waits (bounded) until the status is Ready again.
 *
 * Reaching Ready means the app finished its stop pipeline. It does not prove
 * that a cloud upload succeeded: the app only logs failed uploads.
 * Never uses force-stop or force-local/force-cloud.
 */
export async function shutdownOwnedProfile(
  api: IncognitonApi,
  profileId: string,
  requestGracefulClose: () => Promise<void>,
  options: { stopTimeoutMs: number; graceMs?: number; log?: Log },
): Promise<CleanupReport> {
  const log = options.log ?? silentLog;
  const started = Date.now();
  const deadline = started + options.stopTimeoutMs;
  const graceDeadline = Math.min(deadline, started + (options.graceMs ?? 20000));
  const report: CleanupReport = { profileId, method: 'graceful', ok: false, sawSyncStatus: false, durationMs: 0, warnings: [] };
  try {
    try {
      await requestGracefulClose();
    } catch (error) {
      report.warnings.push(`graceful close request failed: ${sanitize((error as Error).message, 200)}`);
    }
    let status = await getProfileStatus(api, profileId);
    while (status !== READY && Date.now() < graceDeadline) {
      if (TRANSIENT_STATUSES.has(status)) report.sawSyncStatus = true;
      await sleep(250);
      status = await getProfileStatus(api, profileId);
    }
    if (status !== READY && OPEN_STATUSES.has(status)) {
      report.method = 'api-stop';
      report.warnings.push('browser did not exit after the graceful close; used profile.stop(), which terminates the process (very recent storage writes may be lost)');
      log('graceful close did not finish; calling profile.stop()');
      // SDK: client.profile.stop(id) -> GET /profile/stop/{id}; blocks until the app's stop pipeline returns.
      const stopClient = new IncognitonClient(`http://127.0.0.1:${api.port}`, Math.ceil(Math.max(1000, deadline - Date.now()) / 1000));
      const response = (await stopClient.profile.stop(profileId)) as { status?: string; message?: string };
      if (response.status !== 'ok') report.warnings.push(`profile.stop returned: ${sanitize(response.message ?? String(response.status), 200)}`);
    }
    while (status !== READY && Date.now() < deadline) {
      if (TRANSIENT_STATUSES.has(status)) report.sawSyncStatus = true;
      await sleep(500);
      status = await getProfileStatus(api, profileId);
    }
    report.finalStatus = status;
    report.ok = status === READY;
    if (!report.ok) report.error = `profile still "${status}" when the stop deadline passed`;
  } catch (error) {
    report.error = sanitize(error instanceof Error ? error.message : String(error));
  }
  report.durationMs = Date.now() - started;
  return report;
}
