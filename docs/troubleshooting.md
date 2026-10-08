# Troubleshooting Incogniton automation

Start with:

```bash
npm run doctor
```

Add `-- --launch` to also launch, connect and stop your profile end to end, or `-- --json` for machine-readable output ([schema](doctor.md)).

Every example run writes `output/<example-id>/<timestamp>/result.json` and `summary.txt`. On failure the directory also contains `failure-<profile>.png`, and `result.json` lists captured console/page errors and the cleanup outcome. See [result-schema.md](result-schema.md).

## Exit codes

All TypeScript and Python examples, `npm run doctor`, `npm run setup`, `npm run profiles` and `npm run session` use the same codes:

| Code | Kind | Meaning | First thing to try |
| --- | --- | --- | --- |
| 0 | ok | Success (action and cleanup) | |
| 1 | workflow_failed | The page did not reach the expected state (a check failed) | Open `failure-*.png` and `result.json` in the run directory |
| 2 | config_invalid | Bad `.env`/flag value, missing profile ID, fixture port taken | Run `npm run setup`; see the message for the key |
| 3 | api_unreachable | Nothing answered on `127.0.0.1:<INCOGNITON_API_PORT>` | See "API unreachable" below |
| 4 | profile_not_found | The profile ID does not exist for the logged-in account | `npm run profiles -- list` |
| 5 | profile_busy | The profile is already open, or locked by another run of this checkout | Close it in the app / wait for the other run / `npm run session -- stop` |
| 6 | launch_failed | The app refused or failed to launch (message included verbatim) | Read the message: launch limit, out of sync, browser version not installed, proxy |
| 7 | connect_failed | Launched, but Playwright/Puppeteer could not connect over CDP in time | Retry; increase `INCOGNITON_LAUNCH_TIMEOUT_MS`; check security software blocking 127.0.0.1 ports |
| 8 | cleanup_failed | The action succeeded but stopping/deleting did not finish | Check the profile in the app; `npm run profiles -- delete-created --yes` for leftovers |
| 9 | api_error | The API answered with an error that is not one of the above | The message is the API's own text |
| 10 | timeout | A page action or API request exceeded its timeout | `failure-*.png`; increase `INCOGNITON_ACTION_TIMEOUT_MS` only if the page is genuinely slow |
| 11 | unknown | Not classified; the original message is kept | Report it with the sanitized `result.json` |
| 130 | cancelled | Ctrl+C / SIGTERM; cleanup still ran | Press Ctrl+C twice to exit without waiting for cleanup |

If the action failed **and** cleanup failed, the exit code is the action's; both appear in `result.json`.

## API unreachable (exit 3)

The local API simply does not listen in any of these cases, so the starter cannot tell them apart:

- The Incogniton desktop app is not running.
- You are not logged in (the API starts after login).
- The API is disabled or uses another port: Incogniton app → Settings → Automation. Set `INCOGNITON_API_PORT` to match.
- Your plan does not include automation.
- Another program holds the port (the app then cannot start its API).

The API only listens on `127.0.0.1`. Use `127.0.0.1` or `localhost` from the same machine; other hosts and containers cannot reach it.

## Profile already open (exit 5)

The examples refuse to launch a profile that is not `Ready`, because launching an open profile fails after ~26 s and can leave the app reporting `Ready` while the browser still runs. Close the browser window (or `npm run session -- stop` if this starter opened it). If the app shows the profile as `Ready` but a browser window of that profile is still open, close that window.

`Profile <id> is locked by process <pid>`: another run from this checkout is using the profile. If no such process exists, delete `.incogniton/locks/<id>.lock`.

## Connect hangs or `connectOverCDP: Timeout`

Observed when a restored tab is still loading while Playwright attaches. The helpers wait for tabs to settle and retry; the minimal examples retry three times with a 10 s timeout. If it persists, close extra tabs in the profile (Chrome restores them on every launch) and check that nothing intercepts `127.0.0.1` traffic.

## Cookies or localStorage missing after a run

- The browser was stopped with `profile.stop()`/force-stop, which terminates Chrome before it flushes storage. Close it with CDP `Browser.close` and wait for `Ready` (the helpers do).
- `FIXTURE_PORT` (or your site's host/port) changed: storage belongs to an origin.
- You wrote in `browser.newContext()` / Playwright `browser.newPage()`, an isolated context. Use `browser.contexts()[0]`.

See [lifecycle-and-persistence.md](lifecycle-and-persistence.md).

## Launch error messages you may see (exit 6)

Messages are printed verbatim from the app. Known ones:

| Message contains | Meaning |
| --- | --- |
| `reached your profile-launch limit` | Plan/account launch limit for the period |
| `out of sync` | Local and cloud copies differ. Resolve in the app; the starter does not force either side |
| `Browser version not installed` | Open the profile once from the app so it downloads that browser version |
| `No unblocked proxy available`, `Error connecting to proxy` | Proxy problem in the profile settings |
| `do not have permission` | Team role does not allow launching profiles in that group |

## Python

- `Request timed out after 35 seconds`: `incogniton==0.3.0` uses a fixed 35 s HTTP timeout. A launch that has to download a profile from the cloud can exceed it; launch once from the app and retry.
- `ModuleNotFoundError: incogniton`: run with the virtual environment's interpreter (`.venv\Scripts\python` / `.venv/bin/python`) after `pip install -r requirements.lock`.

## Selenium

- `Automation service is being installed, please try again in a moment`: the app downloads its Selenium server after login. Wait and retry.
- `Navigation did not complete: ... Timed out receiving message from renderer` (exit 10), or `invalid session id: session deleted as the browser has closed the connection` after ~60 s with other code: a known intermittent issue on the Incogniton Selenium path (the first navigation sometimes never completes). Run again; the CDP-based examples are not affected. Always set a page-load timeout (`driver.set_page_load_timeout(...)`); the WebDriver default is 300 s.
- `Profile is not in ready state`: the profile is open or still stopping.

## Collecting a useful bug report

Include: example ID, OS, Node/Python version, `npm run doctor -- --json` output, and the run's `result.json`. These files contain no cookies, tokens or proxy credentials, but check them before sharing. Use the [issue template](../.github/ISSUE_TEMPLATE/bug_report.yml).
