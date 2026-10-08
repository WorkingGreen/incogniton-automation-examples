# Developer-experience benchmark (maintainers)

A short comparison with the public automation quickstarts of other antidetect browsers, checked on 2026-10-08. It is meant to find useful patterns and gaps, not to make public claims. No code was copied, and no competitor product was run. Their examples were read, not executed.

## Sources inspected

| Product | Source | What it offers |
| --- | --- | --- |
| Multilogin | [Playwright automation example](https://multilogin.com/help/en_US/playwright-automation-example) (help centre, updated 2026-08) | JS + Python script: sign in for a token, start a profile with an automation type through the local launcher, `connectOverCDP` to the returned port, use the first existing context, screenshot. Profile stop/cleanup is not shown; Python uses a fixed 5 s sleep; no pinned versions or tests |
| AdsPower | [AdsPower/localAPI](https://github.com/AdsPower/localAPI) (GitHub) | JS and Python example folders, README feature list pointing to external API docs, 1 request/second rate limit, desktop app must be running; no visible tests/CI or releases |
| GoLogin | [`gologin` on npm](https://www.npmjs.com/package/gologin) (page summary via search; direct fetch was blocked) | Official SDK package with a Puppeteer example (start profile with an API token → connect to the returned WebSocket endpoint → stop). States Linux, macOS and Windows support plus a cloud-browser option |
| Octo Browser, Dolphin{anty} | — | Official automation docs were not found through search in the time-box; not compared |

## Comparison on the requested dimensions

| Dimension | This repository | Observed in inspected sources |
| --- | --- | --- |
| Time to first successful run | Clean checkout: `npm ci` 15 s + setup/doctor/screenshot 14 s on the test host (validation report) | Not measured (not executed) |
| Complete executable examples | 16 examples, each with command, pass condition, fixture, docs page | Single scripts with placeholders; AdsPower has example folders |
| Persistent-session correctness | Persistence proven across processes (cookie, localStorage, IndexedDB); graceful-stop requirement documented with evidence | Multilogin uses the existing first context (correct) but does not show stopping the profile |
| Language/framework coverage | TS Playwright/Puppeteer, Python Playwright/Selenium | Multilogin JS/Python; AdsPower JS/Python; GoLogin JS (Puppeteer) |
| Recovery / cleanup | Ownership rules, graceful stop with fallback, cancellation handling, locks, leftover reporting | Mostly not shown |
| Diagnostics | Doctor (text/JSON), stable exit codes, `result.json`, failure screenshots, console errors | try/catch + console logging |
| Unattended execution clarity | Explicit: desktop app + logged-in session required; scheduler recipes | GoLogin advertises Linux + cloud browsers, a real advantage for unattended/CI use |
| Version evidence | Pinned deps, lockfiles, `compatibility.json` from live runs | No pinned versions or recorded test results seen |
| AI discoverability | Manifest JSON, standalone task pages, `llms.txt`, `AGENTS.md` | Help-centre articles; no machine-readable index seen |

## Actionable differences for Incogniton

1. **Unattended/CI story is the biggest product gap.** At least one competitor states Linux and cloud-browser support. Incogniton automation needs a logged-in desktop app on Windows/macOS. A headless/service mode or a CI-friendly runner would remove the main blocker for live CI.
2. **Ship stop/cleanup in every official snippet.** Competitor snippets often omit it, and so does the current Incogniton quickstart (its `browser.close()` only disconnects Playwright). Showing the graceful stop is an easy differentiator.
3. **Fix the readiness and status contract in the SDK** (status preflight, `status: 'error'` envelopes, settled-tab wait) so the official one-call path (`IncognitonBrowser.startPlaywright`) is as reliable as this starter's helpers.
4. **Keep a machine-readable example index and version evidence.** None of the inspected sources had one; it helps both humans and AI assistants.
