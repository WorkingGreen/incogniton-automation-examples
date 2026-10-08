# Validation report

Release-candidate validation of `feat/automation-starter`, 2026-10-08. Three kinds of evidence are kept separate: static/unit checks, fixture tests in a conventional browser, and real Incogniton runs. Only the last kind supports a "verified" claim.

## Test host

| Item | Value |
| --- | --- |
| OS | Windows Server 2022 Standard (10.0.20348) x64 |
| Incogniton desktop app | running and logged in; version not exposed by the local API |
| Profile browser | Chrome 152.0.7977.54 (dedicated test profiles, created with the minimal payload) |
| Node.js / npm | 22.23.3 / 10.9 |
| Python | 3.12.7 |
| npm packages | `incogniton@1.0.17`, `playwright-core@1.64.0`, `playwright@1.64.0`, `puppeteer-core@22.15.0`, `tsx@4.23.15`, `typescript@5.9.3` |
| PyPI packages | `incogniton==0.3.0`, `playwright==1.63.0`, `selenium==4.50.0` (full set in `requirements.lock`) |

## 1. Static and unit checks (no Incogniton needed)

`npm run check`: PASS. That covers typecheck; 19 unit/contract tests; manifest, paths and npm-script references; generated-doc drift; relative links; exact dependency pins; and the private-path/secret leak guard. Python: `ruff check`, `ruff format --check` and `compileall` PASS.

The contract tests run against a fake API that replays real response shapes (status preflight, HTTP-200 error envelopes, unreachable API, shutdown fallback). They test the helpers' decisions, not Incogniton.

## 2. Fixture tests (conventional browser, not Incogniton)

`npm run test:fixtures` with Microsoft Edge (`FIXTURE_BROWSER_CHANNEL=msedge`): 8/8 PASS. They cover the form, delayed and cross-origin iframes with postMessage, canvas scaling, the one-cell-per-press rule, pixel observation vs fixture state, deterministic pagination, the network fixture, path-traversal refusal and fixture-server reuse. In hosted CI they run with Playwright's Chromium.

## 3. Real Incogniton runs

Command: `npm run test:live` (scripts/verify-examples.ts), 2026-10-08 09:18 UTC, headless, Chrome 152.0.7977.54. Result: **22 verified, 0 failed, 0 not run.** Raw data: [compatibility.json](compatibility.json).

| Example | Status | Duration |
| --- | --- | --- |
| launch-profile-and-screenshot | verified | 7.8 s |
| click-and-fill-form | verified | 9.3 s |
| reuse-profile-session | verified | 15.5 s |
| interact-with-iframe | verified | 9.0 s |
| control-canvas-game | verified | 16.9 s |
| run-multiple-profiles | verified | 8.7 s |
| attach-to-running-profile | verified | 2.4 s |
| create-and-clean-up-profile | verified | 9.4 s |
| extract-paginated-data | verified | 10.1 s |
| upload-and-download-files | verified | 8.8 s |
| intercept-network-requests | verified | 7.4 s |
| puppeteer-launch-profile-and-screenshot | verified | 8.3 s |
| puppeteer-reuse-profile-session | verified | 15.9 s |
| python-playwright-launch-profile-and-screenshot | verified | 8.1 s |
| python-playwright-reuse-profile-session | verified | 15.8 s |
| python-selenium-launch-profile-and-screenshot | verified | 12.6 s |

Failure paths (expected exit codes from [troubleshooting](troubleshooting.md#exit-codes)):

| Check | Expected | Actual | Status | Note |
| --- | --- | --- | --- | --- |
| unknown-profile-id | 4 | 4 | verified |  |
| api-unreachable-port-override | 3 | 3 | verified |  |
| invalid-configuration | 2 | 2 | verified |  |
| profile-already-open | 5 | 5 | verified |  |
| page-timeout-with-artifacts | 10 | 10 | verified |  |
| cancellation-during-launch | — | — | verified | profile back to Ready |

The two-profile example used two temporary profiles that the runner created and deleted. Earlier the same day, one full run (21/22) failed only on Python Selenium, because of the intermittent navigation hang described in [product-and-documentation-gaps.md](product-and-documentation-gaps.md). That hang reproduced in roughly a third to a half of isolated Selenium attempts, so a passing Selenium run does not mean the issue is gone.

Not tested live: a CDP connection failure after a successful launch (no reliable way to induce it), and real SIGINT delivery on Windows (Node cannot send a catchable SIGINT to a child process there). Cancellation is covered by the in-process AbortSignal check above.

## Clean-checkout installation test

A fresh `git clone` of the branch into an empty temporary directory was used, with PATH limited to the Node binary directory and core utilities. There was no global TypeScript runner, no existing `node_modules`, no `.env` and no sibling SDK checkout. The lockfile resolves only from `registry.npmjs.org`.

| Step | Result |
| --- | --- |
| `npm ci` | 15 s |
| `npm run setup -- --non-interactive --profile-id <id>` | `.env` created, API reachable, profile Ready |
| `npm run doctor` | all checks pass; `app_version`/`automation_entitlement` reported as unknown |
| `npm run example:screenshot` | PASS (14 s for setup + doctor + example) |
| `npm run check`, `npm run typecheck` | PASS (after a fix so `check` also works without `git` on PATH) |
| Python: `python -m venv .venv`, `pip install -r requirements.lock`, Python screenshot example | PASS; `incogniton` imported from the venv (PyPI 0.3.0) |

## Fresh-agent acceptance exercise

A separate coding-agent session got only the repository URL, the Node.js location, the test profile ID and this task: "open the included game fixture, play one round, save a screenshot, verify completion, and stop the profile your run started". It had no SDK knowledge, patches or coaching.

- **Result: PASS on the first attempt, about 52 s from `git clone` to confirmed success.** It ran `npm ci` → `npm run setup -- --non-interactive --profile-id …` → `npm run doctor -- --json` → `npm run example:game`. Its evidence: `Round complete: 3/3 coins in 34 moves`, `pixelStateMismatches: 0`, and `cleanup … ok via graceful, final status Ready`.
- **Discovery path:** directory listing → `AGENTS.md` → `llms.txt` → `package.json` → `.env.example` → `docs/examples/control-canvas-game.md`. It did not need `lib/` or the SDK typings.
- **Invented APIs: none.** It needed no support interventions.
- **Friction reported, and what was fixed:**
  1. `npm run profiles -- --help` crashed with a stack trace. All scripts now print usage for `--help` and exit 2 for unknown flags.
  2. "Game fixture" was not named in `AGENTS.md`. Added a task → command table.
  3. The README quickstart used interactive `npm run setup`. It now uses `npm run setup -- --profile-id <id>`, and any value flag now disables prompts.
  4. It asked for a single machine-readable result line. Every run now ends with `RESULT status=… exit=… cleanup=… json=<path>`.
  5. `llms.txt` links point to `main`. Intentional: they become valid when the branch is merged (pending).
- The affected journey was rerun after the fixes (`example:form`, prints the `RESULT` line) and is covered by the release-candidate live run above.

## Supply chain

`npm audit` reports 8 high-severity advisories, all through `puppeteer-core@22.15.0` → `@puppeteer/browsers` (`extract-zip`, `basic-ftp`, `proxy-agent` chain). Those modules download and unpack browsers and resolve PAC proxies. The examples never call them: they only connect to an Incogniton-launched browser. `puppeteer-core` stays on 22.x because the published `incogniton@1.0.17` declares `puppeteer-core@^22` as a peer. Widening that range in the SDK is tracked as a product gap.

## Not covered

- macOS hosts (documented by the product, not run).
- The release-candidate run is headless (the default). Headed mode (`--headed`) was verified separately the same day on a second test profile: Playwright screenshot, canvas game, Puppeteer screenshot and Python Selenium all PASS. That run happened concurrently with the live run, so two profiles were open at once.
- Live CI: no self-hosted runner exists yet. `live.yml` is prepared for manual dispatch.
- Persistence of recent writes through Selenium's `driver.quit()` path, and fingerprint parity in extra contexts.
- A Spele.nl site adapter was not built: the canvas core is in place, but a site-specific adapter needs a chosen game, verification date and outcome measure.
