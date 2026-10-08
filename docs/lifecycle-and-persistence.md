# Incogniton automation lifecycle and persistence

How an Incogniton profile is launched, connected, used and stopped from code, and what that means for cookies, localStorage and IndexedDB. Statements are marked **verified** (observed against a real Incogniton desktop app, see [compatibility.json](compatibility.json)) or **documented** (from the public API reference, not verified here).

## The short version

1. Check `client.profile.getStatus(id)` is `Ready` (verified: launching an already-open profile fails).
2. Launch with `client.automation.launchPuppeteerCustom(id, customArgs)` and check `status === 'ok'` (verified: errors come back as HTTP 200 with `{"status":"error","message":...}`).
3. Connect your framework to the returned `puppeteerUrl` (a plain CDP endpoint, despite the name).
4. Use the profile's **default context**: Playwright `browser.contexts()[0]`, Puppeteer `browser.newPage()`.
5. Close the tab you opened, then close the browser over CDP (`Browser.close`) and wait until the status is `Ready` again. Use `client.profile.stop(id)` only as a fallback.

## Launching

| Call (official SDK) | What it does | Notes |
| --- | --- | --- |
| `client.automation.launchPuppeteerCustom(id, '--headless=new')` (npm) / `client.automation.launch_puppeteer_custom(id, '--headless=new')` (PyPI) | `POST /automation/launch/puppeteer`, returns `{status:'ok', puppeteerUrl:'http://127.0.0.1:<port>'}` | **Verified.** Blocks until the browser process started (about 1.3–1.7 s on the test host). `customArgs` are appended to the Chrome command line. Pass `''` for a visible window. |
| `client.automation.launchPuppeteer(id)` | `GET` variant without custom args | Documented. |
| `client.automation.launch_selenium_custom(id, args)` (PyPI) | Starts the browser and registers it with the app's local Selenium grid; returns `{status:'ok', url:'127.0.0.1:4444/<id>'}` | **Verified** (about 15 s on the test host). Connect with `webdriver.Remote("http://" + url)`; no local chromedriver is needed. |
| `client.profile.launch(id)` | Opens the profile like the app's Start button | Documented. Returns no CDP endpoint, so it is not usable for automation. Do not call it before `launchPuppeteer*`: the profile would already be open. |
| `IncognitonBrowser.startPlaywright()` / `startPuppeteer()` (npm SDK) | Launch + connect in one call | Works, but in `incogniton@1.0.17` it removes all `SIGINT` listeners of your process, logs to stdout, can hang on connect (see below), and its `close()` only disconnects Playwright. The examples call the client methods directly so every step is visible. |

**Readiness.** The launch call returns once the browser process is up; the DevTools endpoint is normally reachable at that point but the examples still poll `GET <puppeteerUrl>/json/version` with a deadline instead of sleeping.

**Connect race (verified).** With Playwright 1.64 and Chrome 152, `chromium.connectOverCDP()` can wait until its timeout when a tab restored from the previous session is still committing its first navigation. The helpers wait until every page target in `/json/list` reports a URL, then connect with a 10–15 s per-attempt timeout and bounded retries. Connecting is read-only, so retrying is safe. Launching or creating profiles is never retried automatically.

**Already open (verified).** Launching a profile whose browser is running returns, after roughly 26 seconds, `{"status":"error","message":"Browser for '<name>' exited 21 ..."}`. It does not return the existing endpoint, and afterwards `/profile/status` reported `Ready` although the original browser was still running. The examples therefore check the status first and refuse with exit code 5 (`profile_busy`) in well under a second.

## Statuses

`client.profile.getStatus(id)` returns the wire value directly (it replaces the usual `status: 'ok'`). Observed values: `Ready`, `Launched`, `Syncing`. Other values the desktop app can report (not observed in this repository's runs): `Launching`, `Stopping`, `Error`, `Checking proxy`, `Uploading`, `Adding`, `Disabled`, `Opened`, `Launched on different device`. The helpers treat `Launched`/`Launching`/`Opened`/`Launched on different device` as "open", `Syncing`/`Stopping`/`Uploading`/`Checking proxy`/`Adding` as "wait", and anything else as not launchable. An unknown ID returns `{"status":"error","message":"No profile found with that browser id."}`. Note that the published `incogniton@1.0.17` type says lowercase values (`'ready'`); the real values are capitalised.

## Contexts: where the profile's data lives

| Framework | Persistent (profile) context | Isolated, throw-away context |
| --- | --- | --- |
| Playwright (Node/Python) | `browser.contexts()[0]` → `context.newPage()` | `browser.newContext()`, **and `browser.newPage()`** |
| Puppeteer | `browser.newPage()` / `browser.defaultBrowserContext()` | `browser.createBrowserContext()` |
| Selenium (Incogniton grid) | the attached browser | n/a |

**Verified:** a value written to localStorage in the default context was not visible in a `browser.newContext()` context of the same browser. Do not assume fingerprint settings apply identically to extra contexts; this repository does not verify that and the examples never use extra contexts for real work.

Playwright's `connectOverCDP` does not emulate a viewport for the default context, so pages use the profile's window size. Puppeteer emulates 800x600 unless you pass `defaultViewport: null` (the examples do). Calling `page.setViewportSize()` (as the canvas example does) changes the window's content size for that page.

## Stopping and persistence

| How the browser ends | What happens | Persistence of very recent writes |
| --- | --- | --- |
| CDP `Browser.close` (Playwright: `browser.newBrowserCDPSession()` → `send('Browser.close')`; Puppeteer: `browser.close()`) | Chrome shuts down normally; the app notices the exit and runs its stop pipeline (status `Launched` → `Syncing` → `Ready`, about 3 s on the test host) | **Verified kept**: cookie, localStorage and IndexedDB written immediately before closing were present after relaunch (Playwright, Puppeteer, Python). |
| `client.profile.stop(id)` | The app terminates the browser process, then runs the same pipeline; the call returns `{"status":"ok","message":"Profile stopped"}` when it finishes (about 3.5–4.7 s) | **Verified lost**: a cookie and localStorage value written right before `stop` were missing after relaunch (IndexedDB was kept). Values written 40 s before `stop` were kept. |
| `client.profile.forceStop(id)` | Documented as an immediate force stop | Not used by this repository. |
| Playwright `browser.close()` after `connectOverCDP` | Only disconnects | **Verified**: Chrome keeps running and the status stays `Launched`. |
| Puppeteer `browser.disconnect()` | Only disconnects | Leaves the browser running (use for attach scenarios). |
| Selenium `driver.quit()` | The app stops the browser (status back to `Ready` about 5 s later) | **Verified** shutdown; persistence of recent writes through this path was not verified. |

The helpers (`lib/incogniton.ts` `shutdownOwnedProfile`, Python `shutdown_owned_profile`) close the tab the run opened, send `Browser.close`, and wait up to 20 s for the app to leave `Launched`. If the browser does not exit, they call `profile.stop()` and add a warning to `result.json` saying that recent writes may be lost. They never call force-stop or the force-local/force-cloud launch variants: those decide which copy of the profile wins and must be an explicit choice.

**Tabs are restored.** Chrome restores open tabs on the next launch. Each run opens its own tab, so the helpers close that tab before closing the browser. Otherwise every run would add a tab (this happened during development: 24 restored tabs).

**Cloud sync.** Reaching `Ready` after `Syncing` means the app finished its stop pipeline. It is not proof that a cloud upload succeeded: a failed upload is not reported through the API. If you depend on cloud state, check the profile in the app.

## Ownership rules used by every example

- A run that launched a profile stops it, also on failure or Ctrl+C (exit code 130).
- An attached session (`attach-to-running-profile`) only closes its own tab and disconnects.
- `npm run session -- stop` only stops browsers that `npm run session -- start` launched (it needs the session record).
- Profiles are deleted only if their ID is recorded in `.incogniton/created-profiles.json` by this checkout.
- A lock file per profile (`.incogniton/locks/`) stops two processes of this checkout from launching the same profile. It is host-local, not a distributed lock. A lock whose process has exited is treated as stale and replaced (PID reuse can in rare cases keep a stale lock; delete the file if no run is active).

## Concurrency

Profiles are independent browsers. `run-multiple-profiles` ran 3 profiles with concurrency 2 on the test host. Practical limits depend on CPU/RAM, proxies and your plan's launch limits (`You have reached your profile-launch limit for this period.`). This repository does not claim a safe maximum.

## Attach to a running profile

The API does not return the CDP endpoint of a profile that is already open, so you cannot attach to a profile someone opened in the app. You can attach to a browser whose endpoint you recorded when you launched it (`npm run session -- start` does this). See [attach-to-running-profile](examples/attach-to-running-profile.md).
