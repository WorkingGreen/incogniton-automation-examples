// Launch an Incogniton profile through the hosted MCP server (the same tools an AI assistant
// uses), then attach Playwright to the `cdp_url` that `get_launch_status` returns.
//   launch_profile -> get_launch_status (wait for LAUNCHED + cdp_url) -> Playwright -> stop
// cdp_url is a loopback DevTools endpoint on the machine running the Incogniton app, so this
// script must run on that same machine.
// Run: npm run example:mcp -- [--session-id <id>] [--stop-with-mcp]
import { requireProfileId } from '../../lib/config.js';
import { StarterError } from '../../lib/errors.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { createApi, shutdownOwnedProfile, type CleanupReport } from '../../lib/incogniton.js';
import { IncognitonMcpClient } from '../../lib/mcp-client.js';
import { attachPlaywrightSession } from '../../lib/playwright-session.js';
import { check, runExample } from '../../lib/run.js';

type LaunchEntry = { request_type?: string; request_id?: number; status?: string; cdp_url?: string; cdp_unavailable_reason?: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await runExample(
  { id: 'launch-with-mcp-and-attach-playwright', framework: 'playwright', description: 'Launch a profile via the Incogniton MCP server and attach Playwright to its cdp_url.' },
  { 'session-id': { type: 'string' }, 'stop-with-mcp': { type: 'boolean' } },
  async ({ config, flags, artifact, manage, onCleanup, log }) => {
    const profileId = requireProfileId(config);
    const mcp = new IncognitonMcpClient(config.mcpUrl, config.mcpToken);
    // Started before the launch so a fixture-port problem cannot leave a launched browser behind.
    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());
    const server = await mcp.initialize();
    log(`connected to MCP server ${server.serverInfo?.name ?? '?'} ${server.serverInfo?.version ?? ''}`);

    // 1. launch_profile. With several logged-in desktop sessions the server asks which one to use.
    const sessionFlag = flags['session-id'] ? String(flags['session-id']) : config.mcpSessionId;
    const sessionId = sessionFlag ? Number(sessionFlag) : undefined;
    const launch = await mcp.callTool('launch_profile', {
      profile_browser_ID: profileId,
      timeout_seconds: 120,
      ...(sessionId ? { target_session_id: sessionId } : {}),
    });
    if (/specify target_session_id/i.test(launch.text)) {
      const sessions = await mcp.callTool('get_eligible_sessions', { profile_browser_ID: profileId });
      const list = (sessions.json as Array<{ session_id: number; device_name?: string; last_active?: string }> | undefined) ?? [];
      throw new StarterError('config_invalid', `Several desktop sessions can launch this profile: ${list.map((s) => `${s.session_id} (${s.device_name ?? '?'}, active ${s.last_active ?? '?'})`).join('; ')}`, {
        hint: 'Pass --session-id <id> (or set INCOGNITON_MCP_SESSION_ID) for THIS machine. Its id is in the Incogniton app log ("authenticated successfully (session_id=...)"). A launch sent to another session opens the profile on that device.',
      });
    }
    if (launch.isError || !/created successfully/i.test(launch.text)) {
      throw new StarterError('launch_failed', `launch_profile refused: ${launch.text.slice(0, 300)}`);
    }
    const requestId = Number(/Request ID:\s*(\d+)/i.exec(launch.text)?.[1]);
    check(Number.isInteger(requestId), `no request id in launch_profile answer: ${launch.text.slice(0, 200)}`);
    log(`launch request ${requestId} created; waiting for the desktop app to pick it up`);

    // 2. get_launch_status, filtered by profile (that form returns JSON including cdp_url).
    let entry: LaunchEntry | undefined;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const status = await mcp.callTool('get_launch_status', { profile_browser_ID: profileId, include_stop_requests: false, limit: 5 });
      entry = (status.json as LaunchEntry[] | undefined)?.find((e) => e.request_id === requestId);
      if (entry && entry.status !== 'PENDING') break;
    }
    if (entry?.status !== 'LAUNCHED') {
      throw new StarterError('launch_failed', `launch request ${requestId} ended as ${entry?.status ?? 'unknown (not picked up)'}`, {
        hint: 'The desktop app must be running and logged in on the target session; requests expire after the timeout.',
      });
    }
    /**
     * stop_profile, then wait (bounded) for that stop request to finish. Polls by the stop
     * request's own id: the server can attach a stop to an older launch of the same profile
     * whose (graceful) close it never recorded, so matching on the launch id is unreliable.
     */
    const stopViaMcp = async (): Promise<CleanupReport> => {
      const started = Date.now();
      const stop = await mcp.callTool('stop_profile', { profile_browser_ID: profileId, ...(sessionId ? { target_session_id: sessionId } : {}) });
      const stopId = Number(/Request ID:\s*(\d+)/i.exec(stop.text)?.[1]);
      let stopStatus = Number.isInteger(stopId) ? 'PENDING' : `refused: ${stop.text.slice(0, 120)}`;
      while (stopStatus === 'PENDING' && Date.now() - started < 60_000) {
        await sleep(1500);
        const st = await mcp.callTool('get_launch_status', { profile_browser_ID: profileId, include_stop_requests: true, limit: 10 });
        const s = (st.json as LaunchEntry[] | undefined)?.find((e) => e.request_type === 'STOP' && e.request_id === stopId);
        if (s && s.status !== 'PENDING') stopStatus = s.status ?? 'unknown';
      }
      return { profileId, method: 'mcp-stop', ok: stopStatus === 'STOPPED', sawSyncStatus: false, finalStatus: `mcp:${stopStatus}`, durationMs: Date.now() - started, warnings: [] };
    };

    // From here this run owns a running browser: stop it if anything fails before cleanup is registered.
    if (!entry.cdp_url) {
      await stopViaMcp();
      throw new StarterError('connect_failed', `Launched, but no cdp_url: ${entry.cdp_unavailable_reason ?? 'no reason given'}`, {
        hint: 'cdp_url needs the browser\'s DevTools port; check that browser remote control is allowed in the Incogniton app.',
      });
    }
    log(`launched; cdp_url ${entry.cdp_url}`);

    // 3. Attach Playwright to the browser the MCP request started (this run owns it).
    let attached: Awaited<ReturnType<typeof attachPlaywrightSession>>;
    try {
      attached = await attachPlaywrightSession(config, { profileId, cdpUrl: entry.cdp_url, log });
    } catch (error) {
      await stopViaMcp();
      throw error;
    }
    const api = createApi(config);
    const cdpUrl = entry.cdp_url;
    manage({
      profileId,
      browserVersion: attached.browserVersion,
      page: attached.page,
      async close(): Promise<CleanupReport> {
        if (flags['stop-with-mcp']) {
          // 4b. MCP-native stop: the desktop app runs its stop pipeline.
          await attached.close();
          return stopViaMcp();
        }
        // 4a. Default: close the browser gracefully over CDP (flushes cookies/storage), then wait
        //     for the desktop app to report Ready via the local API.
        await attached.page.close().catch(() => undefined);
        return shutdownOwnedProfile(api, profileId, async () => {
          const cdp = await attached.browser.newBrowserCDPSession();
          await cdp.send('Browser.close').catch(() => undefined);
          await attached.browser.close().catch(() => undefined);
        }, { stopTimeoutMs: config.stopTimeoutMs, log });
      },
    });

    await attached.page.goto(fixtures.url('index.html'));
    await attached.page.getByRole('status').filter({ hasText: 'Fixture ready' }).waitFor();
    await attached.page.screenshot({ path: artifact('mcp-attached.png') });
    const heading = await attached.page.getByRole('heading', { level: 1 }).textContent();
    check(heading === 'Incogniton automation fixture', `unexpected heading ${heading}`);

    return {
      summary: `Launched via MCP (request ${requestId}), attached Playwright to ${cdpUrl} and verified the fixture in ${attached.browserVersion}.`,
      details: { requestId, cdpUrl, stopWith: flags['stop-with-mcp'] ? 'mcp stop_profile' : 'graceful Browser.close' },
    };
  },
);
