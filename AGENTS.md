# AGENTS.md — working in incogniton-automation-examples

Instructions for coding agents (and humans) changing or using this repository.

## Map

- `examples/index.json` — authoritative manifest of every example (schema: `examples/index.schema.json`). Docs, the README table and `llms.txt` are generated from it.
- `examples/playwright/*.ts`, `examples/puppeteer/*.ts` — Node.js examples. `launch-profile-and-screenshot.ts` (both folders) are self-contained; the rest use `lib/`.
- `examples/python/{playwright,selenium}/*.py` + `examples/python/starter_common.py` — Python examples and their helpers.
- `starter/src/main.ts` — the starter app; add business logic in `starter/src/workflows/` and register it in `workflows/index.ts`.
- `lib/` — repository helpers (config, lifecycle, fixtures, runner). **These are not Incogniton SDK methods.** Keep that distinction in code comments and docs.
- `fixtures/` — deterministic local pages served on `127.0.0.1:47811` / `:47812`.
- `scripts/` — setup, doctor, profiles, session, docs generator, static checks, live verification.
- `tests/unit` (no browser), `tests/fixtures` (conventional browser), `scripts/verify-examples.ts` (real Incogniton).
- `docs/examples/*.md`, `llms.txt`, `llms-full.txt`, `.env.example` — **generated**; edit the manifest/sources and run `npm run docs:generate`.

## Task → command

Every run prints a final line `RESULT status=<passed|failed|...> exit=<code> cleanup=<ok|failed|none> json=<absolute path of result.json>`; artifacts are listed in that `result.json`.

| Task | Command | Fixture / evidence |
| --- | --- | --- |
| Screenshot of a page in a profile | `npm run example:screenshot` | prints `PASS: ...screenshot.png` |
| Fill and submit a form | `npm run example:form` | `fixtures/form.html`; `after-submit.png` |
| Keep cookies/storage between runs | `npm run example:persistence` | `fixtures/storage.html`; write + verify runs |
| Work inside iframes | `npm run example:iframe` | `fixtures/iframe.html` |
| Play the canvas game fixture (one round) | `npm run example:game` | `fixtures/game.html`; `complete.png` |
| Several profiles at once | `npm run example:multi -- --profile-ids <a>,<b>` | `workers.json` |
| Attach to a running browser | `npm run session -- start`, then `npm run example:attach`, then `npm run session -- stop` | `attached.png` |
| Create and delete a temporary profile | `npm run example:temp-profile` | `temporary-profile.png` |
| Scrape a paginated table | `npm run example:extract` | `products.json` |
| Upload / download files | `npm run example:files` | `report.csv` |
| Mock / block network requests | `npm run example:network` | `network.png` |
| Puppeteer instead of Playwright | `npm run example:puppeteer:screenshot`, `npm run example:puppeteer:persistence` | |
| Python | `python examples/python/playwright/launch_profile_and_screenshot.py` (venv, see README) | |
| Your own logic | edit `starter/src/workflows/`, run `npm start -- --workflow <name>` | `output/starter/` |

All scripts accept `--help`; `--headed` shows the browser window.

## Source of truth for the Incogniton API

Use the **installed** SDK, not memory or older docs: `node_modules/incogniton/dist/**/*.d.ts` (npm, pinned 1.0.17) and `.venv/Lib|lib/.../site-packages/incogniton/` (PyPI, pinned 0.3.0). Node.js methods are camelCase (`client.automation.launchPuppeteerCustom`), Python snake_case (`client.automation.launch_puppeteer_custom`). Known wrong types in 1.0.17: `profile.list()` returns `profileData` (not `profiles`); status values are capitalised (`Ready`, `Launched`). See `docs/product-and-documentation-gaps.md`.

## Commands (no prompts, safe for agents)

```bash
npm ci
```

```bash
npm run setup -- --non-interactive --profile-id <dedicated-test-profile-id>
```

```bash
npm run doctor -- --json
```

```bash
npm run check
```

```bash
npm run example:screenshot
```

```bash
npm run test:live
```

`npm run check` = typecheck + unit/contract tests + manifest/link/script validation + doc drift + leak guard (no Incogniton needed). `npm run test:fixtures` needs a Chromium (`npx playwright install chromium`, or `FIXTURE_BROWSER_CHANNEL=msedge`). `npm run test:live` needs the real desktop app, logged in, and a dedicated test profile; it rewrites `docs/compatibility.json`. Python lint: `python -m ruff check` inside the venv.

## Rules

1. **Connect through Incogniton.** Integration examples must launch via the SDK (`launchPuppeteerCustom` / `launch_selenium_custom`) and connect to the returned endpoint. Never substitute `chromium.launch()` or a stock browser; that is only allowed in `tests/fixtures`.
2. **Use the persistent context.** Playwright: `browser.contexts()[0]`. Never `browser.newPage()`/`newContext()` for profile work. Puppeteer: `browser.newPage()` is the default context.
3. **Respect ownership.** Stop only what your run launched (graceful CDP `Browser.close`, wait for `Ready`, `profile.stop()` as fallback). Attached sessions only disconnect. Delete only profiles recorded in `.incogniton/created-profiles.json`. Never force-stop or force local/cloud sync implicitly. Never launch, stop or delete a user's other profiles.
4. **Close the tab you opened** before closing the browser (Chrome restores tabs).
5. **No fixed sleeps for readiness.** Poll with deadlines; retry only read-only steps (connecting), never launches, creates or submissions.
6. **No secrets in output.** Do not log profile payloads (they contain proxy credentials), cookies or tokens. Use `sanitize()`.
7. **When you add or change an example:** update `examples/index.json`, add an npm script for TypeScript examples, run `npm run docs:generate`, `npm run check`, and the live run for that example (`npm run test:live -- --only <id>`).

## When can something be called "tested"?

- **verified**: it ran successfully against a real Incogniton desktop app and the result is in `docs/compatibility.json` (written by `npm run test:live`).
- Fixture tests and the fake-API contract tests are **not** Incogniton evidence.
- If the app, an account entitlement or a supported host is not available, say so ("blocked"/"not-run"); never report success you did not observe.
