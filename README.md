# Incogniton automation examples (official)

Official, runnable starter for automating the [Incogniton](https://incogniton.com) antidetect browser with **Playwright** and **Puppeteer** (Node.js/TypeScript) and **Playwright** and **Selenium** (Python). Every example launches a real Incogniton profile through the official SDKs ([`incogniton` on npm](https://www.npmjs.com/package/incogniton), [`incogniton` on PyPI](https://pypi.org/project/incogniton/)), verifies an observable result, writes artifacts, and stops the profile cleanly. API reference: [api-docs.incogniton.com](https://api-docs.incogniton.com).

## Prerequisites

- **Windows or macOS** with the **Incogniton desktop app** installed, **running and logged in**. The app is a desktop application; Linux, Docker and hosted CI cannot run it ([details](docs/unattended-execution.md)).
- A plan that includes **automation**, with the local API enabled: Incogniton app → Settings → Automation (default `127.0.0.1:35000`, no API key).
- An existing, closed **test profile**. The examples write test cookies/storage for local test pages to it, so do not use a profile you care about. `npm run setup -- --create-test-profile` can create one.
- **Node.js 22.12+** and npm. Python 3.10+ only for the Python examples.

## Quickstart

```bash
git clone https://github.com/WorkingGreen/incogniton-automation-examples.git
```

```bash
cd incogniton-automation-examples
```

```bash
npm ci
```

```bash
npm run setup
```

```bash
npm run doctor
```

```bash
npm run example:screenshot
```

`npm run setup` asks for the API port and profile ID. Use `npm run setup -- --profile-id <id>` (or `--non-interactive`) for scripts and coding agents. List profile IDs with `npm run profiles -- list`.

Expected output of the last command:

```text
PASS: 152.0.7977.54 rendered the fixture; screenshot saved to output/launch-profile-and-screenshot/<timestamp>/screenshot.png
Profile status after cleanup: Ready
```

The browser version depends on your profile. Pass `--headed` to watch the browser window (`npm run example:screenshot -- --headed`).

## The connection in one screen

From [examples/playwright/launch-profile-and-screenshot.ts](examples/playwright/launch-profile-and-screenshot.ts) (complete, self-contained file):

```ts
import { IncognitonClient } from 'incogniton';
import { chromium } from 'playwright-core';

const client = new IncognitonClient('http://127.0.0.1:35000', 120);           // timeout in seconds
const { status } = await client.profile.getStatus(PROFILE_ID);                  // must be "Ready"
const launch = await client.automation.launchPuppeteerCustom(PROFILE_ID, '--headless=new');
if (launch.status !== 'ok') throw new Error(launch.message);                    // errors arrive with HTTP 200
const browser = await chromium.connectOverCDP(launch.puppeteerUrl);
const context = browser.contexts()[0];                                          // the profile's persistent context
const page = await context.newPage();                                           // not browser.newPage()!
// ... work ...
await page.close();                                                             // Chrome restores open tabs
await (await browser.newBrowserCDPSession()).send('Browser.close');             // graceful: storage is flushed
// then poll client.profile.getStatus(PROFILE_ID) until "Ready"
```

Why each line matters: [Lifecycle and persistence](docs/lifecycle-and-persistence.md).

## Examples

Each link is a standalone page with prerequisites, the exact command, complete code, expected result and failure guidance.

<!-- examples:start -->
| Task | Language · framework | Command | Live status |
| --- | --- | --- | --- |
| [How do I automate Incogniton with Playwright?](docs/examples/launch-profile-and-screenshot.md) | TypeScript · playwright | `npm run example:screenshot` | verified 2026-10-08 |
| [How do I click buttons and fill forms in an Incogniton profile?](docs/examples/click-and-fill-form.md) | TypeScript · playwright | `npm run example:form` | verified 2026-10-08 |
| [How do I preserve cookies and localStorage in Incogniton automation?](docs/examples/reuse-profile-session.md) | TypeScript · playwright | `npm run example:persistence` | verified 2026-10-08 |
| [How do I automate an iframe in an Incogniton profile?](docs/examples/interact-with-iframe.md) | TypeScript · playwright | `npm run example:iframe` | verified 2026-10-08 |
| [How do I automate a canvas game in an Incogniton profile?](docs/examples/control-canvas-game.md) | TypeScript · playwright | `npm run example:game` | verified 2026-10-08 |
| [How do I run multiple Incogniton profiles concurrently?](docs/examples/run-multiple-profiles.md) | TypeScript · playwright | `npm run example:multi -- --profile-ids <id1>,<id2>` | verified 2026-10-08 |
| [How do I connect to an existing Incogniton profile without restarting it?](docs/examples/attach-to-running-profile.md) | TypeScript · playwright | `npm run example:attach` | verified 2026-10-08 |
| [How do I create an Incogniton profile from code?](docs/examples/create-and-clean-up-profile.md) | TypeScript · playwright | `npm run example:temp-profile` | verified 2026-10-08 |
| [How do I scrape a paginated table with Playwright in Incogniton?](docs/examples/extract-paginated-data.md) | TypeScript · playwright | `npm run example:extract` | verified 2026-10-08 |
| [How do I upload and download files with Playwright in Incogniton?](docs/examples/upload-and-download-files.md) | TypeScript · playwright | `npm run example:files` | verified 2026-10-08 |
| [How do I intercept or mock network requests in Incogniton automation?](docs/examples/intercept-network-requests.md) | TypeScript · playwright | `npm run example:network` | verified 2026-10-08 |
| [How do I automate Incogniton with Puppeteer?](docs/examples/puppeteer-launch-profile-and-screenshot.md) | TypeScript · puppeteer | `npm run example:puppeteer:screenshot` | verified 2026-10-08 |
| [How do I keep a Puppeteer session logged in across Incogniton runs?](docs/examples/puppeteer-reuse-profile-session.md) | TypeScript · puppeteer | `npm run example:puppeteer:persistence` | verified 2026-10-08 |
| [How do I take screenshots using the Incogniton Python SDK?](docs/examples/python-playwright-launch-profile-and-screenshot.md) | Python · playwright | `python examples/python/playwright/launch_profile_and_screenshot.py` | verified 2026-10-08 |
| [How do I preserve cookies with Incogniton and Playwright for Python?](docs/examples/python-playwright-reuse-profile-session.md) | Python · playwright | `python examples/python/playwright/reuse_profile_session.py` | verified 2026-10-08 |
| [How do I use Selenium with Incogniton?](docs/examples/python-selenium-launch-profile-and-screenshot.md) | Python · selenium | `python examples/python/selenium/launch_profile_and_screenshot.py` | failed |
<!-- examples:end -->

More example commands:

```bash
npm run example:persistence
```

```bash
npm run example:game -- --headed
```

```bash
npm run example:multi -- --profile-ids <id1>,<id2>
```

## Language and framework support

| Path | Package (pinned) | Launch | Persistent context | Examples |
| --- | --- | --- | --- | --- |
| Node.js + Playwright | `incogniton@1.0.17`, `playwright-core@1.64.0` | `client.automation.launchPuppeteerCustom` → `chromium.connectOverCDP` | `browser.contexts()[0]` | all 11 Playwright examples + starter |
| Node.js + Puppeteer | `incogniton@1.0.17`, `puppeteer-core@22.15.0` | same → `puppeteer.connect({ browserURL, defaultViewport: null })` | `browser.newPage()` | screenshot, persistence |
| Python + Playwright | `incogniton==0.3.0`, `playwright==1.63.0` | `client.automation.launch_puppeteer_custom` → `connect_over_cdp` | `browser.contexts[0]` | screenshot, persistence |
| Python + Selenium | `incogniton==0.3.0`, `selenium==4.50.0` | `client.automation.launch_selenium_custom` → `webdriver.Remote` via the app's grid | the attached browser | navigate, form, screenshot |
| Node.js + Selenium | not provided | the npm SDK has the launch methods, but no example is maintained here | | |

Live verification status per example: [docs/compatibility.json](docs/compatibility.json) and [validation report](docs/validation-report.md). Choose Playwright unless you need Puppeteer's API or an existing Selenium codebase; see [extending](docs/extending.md).

## Build your own automation

The starter app runs a workflow function with configuration, launch, connection, artifacts and cleanup handled for you:

```bash
npm start
```

Edit [starter/src/workflows/example-workflow.ts](starter/src/workflows/example-workflow.ts) or add a workflow next to it and register it in [workflows/index.ts](starter/src/workflows/index.ts). Then run `npm start -- --workflow <name>`. Repeated, non-overlapping runs: `npm start -- --repeat 12 --interval 300`. Adding a documented example: [docs/extending.md](docs/extending.md).

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run doctor` | Check Node, dependencies, configuration, API, profile; `-- --launch` for an end-to-end test, `-- --json` for machine output |
| `npm run profiles -- list` | List profile IDs (no proxy credentials are printed) |
| `npm run profiles -- create` / `-- delete-created --yes` | Create a test profile / delete only profiles this checkout created |
| `npm run session -- start` / `list` / `stop` | Keep a profile browser running for attach scenarios |
| `npm run fixtures` | Serve the local test pages for manual inspection |
| `npm run check` | Static checks (types, tests, manifest, docs drift, links) |
| `npm run test:live` | Run every example against your Incogniton app and update `docs/compatibility.json` |

## Documentation

- [Lifecycle and persistence](docs/lifecycle-and-persistence.md): launch, contexts, graceful stop, what persists
- [Troubleshooting and exit codes](docs/troubleshooting.md)
- [Unattended and scheduled execution](docs/unattended-execution.md)
- [Extending the starter](docs/extending.md)
- [Run result schema](docs/result-schema.md) · [Doctor](docs/doctor.md)
- [Product and documentation gaps](docs/product-and-documentation-gaps.md) · [Validation report](docs/validation-report.md)
- For coding agents: [AGENTS.md](AGENTS.md), [llms.txt](llms.txt), [examples/index.json](examples/index.json)

## License

[MIT](LICENSE). Use these examples only on websites and accounts you are allowed to automate, and within their terms.
