# Product and documentation gaps (maintainers)

Findings from building and verifying this repository (2026-10-08). "Verified" means observed against a real Incogniton desktop app on Windows Server 2022 with Chrome 152 profiles; "source" means read from the published package code. This starter works around each gap and says so in code comments. Its default install path uses only released packages: `incogniton@1.0.17` (npm) and `incogniton==0.3.0` (PyPI).

## Documentation discrepancies investigated

| # | Observation in the public docs | Resolution (what actually works) | Evidence |
| --- | --- | --- | --- |
| 1 | The quickstart declares `profileId` but constructs `new IncognitonBrowser({ headless: true })` without it | Pass it: `new IncognitonBrowser({ profileId, headless })` or `startPlaywright(profileId)`. Without it the launch request has no profile and fails | source: `IncognitonBrowser.startPlaywright` sends `profileID: profileId \|\| this.config.profileId` |
| 2 | The Node.js SDK reference lists snake_case names (`client.profile.get_status`, `client.automation.launch_puppeteer_custom`, `browser.start_playwright`) | Node.js uses camelCase: `getStatus`, `launchPuppeteerCustom`, `startPlaywright`, `forceStop`, `launchForceLocal`, `switchProxy`. snake_case is the Python SDK | `incogniton@1.0.17` `dist/api/incogniton.client.d.ts` |
| 3 | Profile-creation examples use different shapes | Node: `client.profile.add({ profileData: { general_profile_information: { profile_name } } })`. Python: `await client.profile.add({"profileData": {...}})`. Only `profile_name` is needed; the app fills in the fingerprint, newest browser version, group "Unassigned" and host OS. The ID is returned as `profile_browser_id` | verified (`create-and-clean-up-profile`) |
| 4 | Playwright examples use `browser.newPage()` | In Playwright that creates a **new, empty context** without the profile's cookies/storage. Use `browser.contexts()[0].newPage()` | verified: localStorage written in the default context is not visible in `browser.newContext()` |
| 5 | Some examples call `client.profile.launch(id)` and then `IncognitonBrowser.startPlaywright()` | Launch once, for automation (`launchPuppeteerCustom` or `startPlaywright`). `profile.launch` returns no CDP endpoint, and launching an already-open profile fails | verified: second launch → `{"status":"error","message":"Browser for '<name>' exited 21 ..."}` after ~26 s |
| 6 | A manual connection guide waits `delay(30000)` after launching | Poll `GET <puppeteerUrl>/json/version` with a deadline, then connect with bounded retries; launches took 1.3–1.7 s on the test host | verified |

## Product / SDK gaps

| Gap | Impact | Workaround in this repository | Suggested fix |
| --- | --- | --- | --- |
| `GET /profile/stop/{id}` terminates Chrome before it flushes storage | **Verified data loss**: cookie and localStorage written just before `stop` were missing after relaunch (IndexedDB kept) | Close via CDP `Browser.close`, wait for `Ready`; `stop` only as fallback, with a warning in `result.json` | Attempt a graceful browser close (with a short timeout) before terminating |
| Launching an already-open profile: ~26 s, error `exited 21`, and the status then reads `Ready` while the browser still runs | Slow failure; wrong status misleads schedulers and UIs | Status preflight; refuse with exit 5 | Reject immediately when not `Ready`; do not reset the status on that path |
| No API returns the CDP endpoint of a running profile | Cannot attach to a profile opened in the app or by another process | `npm run session -- start` records the endpoint for later attach | Return the existing endpoint for automation-launched profiles, or add an endpoint query route |
| Errors use HTTP 200 with `{"status":"error"}`; the SDKs neither throw nor type it for launch calls | Callers that only check HTTP success treat failures as success | Helpers check `status === 'ok'` | Throw a typed error in the SDKs |
| npm `incogniton@1.0.17` types: `profile.list()` says `profiles` (wire: `profileData`); `ProfileStatus` is lowercase (wire: `Ready`, `Launched`, …) | Type-correct code is wrong at runtime | Casts with comments | Publish the newer SDK source, which fixes `list()`; fix the status union |
| npm `IncognitonBrowser` (1.0.17): `process.removeAllListeners('SIGINT')`, emoji debug output, `launchTimeout` (ms) passed as seconds, `close()` only disconnects Playwright, internal client ignores `port` | Host app signal handlers lost; noisy logs; profile left running | Examples call `IncognitonClient` methods directly | Release the newer SDK source (fixes the SIGINT, timeout and logging points); make `close()` stop the profile |
| npm `HttpError`/`TimeoutError` do not set `name` | Error classification by name fails | `instanceof` checks | Set `name`; expose the network error code |
| `connectOverCDP` intermittently waits for its full timeout when a restored tab is mid-navigation (Playwright 1.64, Chrome 152) | `IncognitonBrowser.startPlaywright()` can hang 30 s | Wait for settled tabs (`/json/list`), per-attempt timeout, bounded retries | Same readiness logic in the SDK |
| Python `incogniton==0.3.0`: fixed 35 s HTTP timeout, no option | Slow launches / stop+sync can exceed it | Status polling instead of long blocking calls | Add a `timeout` parameter to `IncognitonClient` |
| Python `IncognitonBrowser.start_selenium()` adds `--headless=new` to WebDriver options, but the app starts the browser before WebDriver attaches | `headless=True` has no effect on that path (source reading) | Example passes headless via `launch_selenium_custom(id, '--headless=new')` | Pass headless as launch `customArgs` |
| Selenium path: while a client command is in flight (for example a slow page load), the app's session watcher cannot get an answer from the busy session and stops the browser about 60 s after launch; the client sees `invalid session id: session deleted as the browser has closed the connection`, and the grid session plus its chromedriver are left running until the node timeout. Separately, the first navigation intermittently stalled (cause not identified; not reproducible later the same day) | Any Selenium command longer than ~50 s, or a stalled navigation, loses the session | Page-load timeout = action timeout so the client fails first with a clear message; no automatic relaunch | Treat an unanswered poll as alive while the browser's DevTools endpoint answers, and delete the grid session when declaring death (fix prepared in the app, pending release) |
| `puppeteer-core` peer range `^22` in the npm SDK | Forces an old Puppeteer major (npm audit reports advisories in its dependency tree) | Pinned 22.15.0 (tested) | Test and widen the peer range |
| No app-version or entitlement endpoint | Doctor cannot report the app version or plan entitlement | Reported as `unknown` | Add `GET /version` (app + browser versions) |

## Not verified / blocked in this repository

- macOS hosts: documented by the product, not run here.
- Persistence of very recent writes through Selenium's `driver.quit()` path.
- Fingerprint behaviour in additional (non-default) browser contexts.
- Cloud-sync completion: the API gives no signal that an upload succeeded.
- Hosted CI with a live app: blocked (needs a logged-in desktop app); see [validation-report.md](validation-report.md).

## MCP

Observed against the hosted MCP server (`incogniton-mcp` 1.0.0) on 2026-10-08.

| Gap | Impact | Workaround in this repository | Suggested fix |
| --- | --- | --- | --- |
| `stop_profile` can attach the stop to an **older** launch of the same profile whose browser was closed without MCP (for example via CDP `Browser.close`); the newer launch keeps reporting `LAUNCHED` | `get_launch_status` shows a running browser that is gone; polling by launch id never sees the stop | Poll by the stop request's own id | Mark a launch closed when the desktop reports the browser exited, whatever closed it; attach stops to the newest open launch |
| Several "active" desktop sessions, all named "Unknown Device"; `launch_profile` then refuses to choose | An AI client cannot tell which device a launch will open on; a wrong guess opens the profile on another computer | Require an explicit session id; tell the user where to find it | Send device names with every session; expire sessions that stopped polling; expose "this device" to local clients |
| `get_launch_status` by `request_id` returns prose without `cdp_url`; by `profile_browser_ID` it returns JSON with `cdp_url` | Clients following the tool description ("call get_launch_status with the request_id") don't get the endpoint | Query by profile and match the request id | Return the same JSON entry for both query forms |
| Tool results are prose with an embedded JSON block | Programmatic clients must scrape | `extractJson` in lib/mcp-client.ts | Also return MCP `structuredContent` |
| The `notifications/initialized` notification gets a JSON-RPC error response; the server answers `protocolVersion` 2024-11-05 to the bridge's 2026-05-15 | Strict MCP clients may log errors or refuse | None needed for the bridge | Don't respond to notifications; negotiate the version the client asked for when supported |
