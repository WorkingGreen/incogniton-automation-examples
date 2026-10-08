# Extending the starter

## Add business logic (starter app)

1. Copy `starter/src/workflows/example-workflow.ts` to `starter/src/workflows/my-task.ts` and change `name`, `description` and `run`.
2. Register it in `starter/src/workflows/index.ts`.
3. Run it:

```bash
npm start -- --workflow my-task
```

A workflow receives `page` (a new tab in the profile's persistent context), `context`, `profileId`, `config`, `fixtures`, `artifact(name)`, `log` and `signal`. Return `{ summary, details }`; throw (or call `check()`) when the outcome is wrong. Do not stop the profile yourself: the runner owns the lifecycle, takes a failure screenshot, records console errors and writes `result.json` ([schema](result-schema.md)). `npm start -- --workflow failure-demo` shows what a failure produces.

Define a **pass condition** for every workflow: a specific text, URL, element state or file content that only appears when the task really succeeded. "No exception" is not a pass condition.

## Add a documented example

1. Create the source, for example `examples/playwright/my-example.ts`, following the existing examples (`runExample` + `openPlaywrightSession` + `manage`). For Python, follow `examples/python/playwright/*.py`.
2. Add an npm script in `package.json` (`"example:my-example": "tsx examples/playwright/my-example.ts"`).
3. Add an entry to `examples/index.json` (fields: [index.schema.json](../examples/index.schema.json)): a natural-language title and question, exact command, prerequisites, config keys, expected result (the observable pass condition), lifecycle notes, known failures and related examples.
4. Generate and check:

```bash
npm run docs:generate
```

```bash
npm run check
```

5. Verify against the real app and record the result:

```bash
npm run test:live -- --only my-example
```

A subset run does not rewrite `docs/compatibility.json`. Run the full `npm run test:live` before calling the example "verified" in the docs.

## Use your own site instead of the fixtures

Replace `fixtures.url('...')` with your URL. Keep in mind:

- Wait for content that proves the page is ready (`getByRole(...).waitFor()`), not for `load` or fixed sleeps.
- Storage and cookies belong to the site's origin; they persist in the profile only through the default context and a graceful shutdown.
- Respect the site's terms; do not automate accounts or actions you are not allowed to.

## Choosing Playwright, Puppeteer or Selenium

| Choose | When |
| --- | --- |
| Playwright (Node.js or Python) | Default. Auto-waiting locators, frames, downloads, routing and tracing all work over CDP; every example exists for it |
| Puppeteer | You already have Puppeteer code or need its CDP-centric API. `browser.close()` really closes the browser (graceful); use `browser.disconnect()` to leave it running |
| Selenium (Python) | You have an existing Selenium suite. The app provides the WebDriver endpoint through its local grid; launches were slower (~15 s vs ~1.5 s for CDP on the test host) |

## Limits of CDP connections

Connecting to an existing browser over CDP (all Node.js/Python Playwright and Puppeteer paths here) differs from a framework-launched browser:

- There is no framework-controlled browser process: `browser.close()` in Playwright only disconnects. Stop the profile through Incogniton (graceful `Browser.close`, see [lifecycle](lifecycle-and-persistence.md)).
- Launch options of the frameworks (`args`, `proxy`, `userDataDir`, `viewport` for the default context) do not apply. The profile's settings come from Incogniton. Extra Chrome flags go into `customArgs` of the launch call.
- Playwright features verified here over CDP: navigation, locators, iframes (incl. cross-origin), keyboard/mouse, screenshots, downloads, uploads, `page.route`. Not verified here: tracing, video recording, `newContext()` fingerprint parity.

## Diagnostics you get for free

- `result.json` + `summary.txt` per run, unique run directories under `output/` (ignored by git).
- Failure screenshot, browser console errors and uncaught page errors.
- Sanitized messages: URLs with credentials and proxy/password/token fields are masked. Do not add raw API responses to `details`: profile payloads contain proxy credentials.
