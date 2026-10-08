# GitHub repository metadata (prepared, apply manually)

These settings could not be applied from the build environment (no GitHub CLI/API token available). Apply them in the repository settings, or with the GitHub CLI once the branch is merged.

**Description (About):**

> Official Incogniton automation starter: runnable Playwright, Puppeteer, Python and Selenium examples with persistent sessions, diagnostics and verified results.

**Website:** `https://api-docs.incogniton.com`

**Topics:** `incogniton`, `antidetect-browser`, `browser-automation`, `playwright`, `puppeteer`, `selenium`, `cdp`, `web-automation`, `typescript`, `python`, `examples`, `starter-template`

**Template repository:** enable ("Settings → General → Template repository"). Generated copies keep `examples/index.json`, docs and checks working without changes.

**Releases:** tag the first release after merge (for example `v0.1.0`) and reference SDK versions in the notes: `incogniton@1.0.17` (npm), `incogniton==0.3.0` (PyPI). Version-stable source links: `https://github.com/WorkingGreen/incogniton-automation-examples/blob/v0.1.0/<path>`.

**Environment for live verification:** create environment `incogniton-live` with required reviewers, a self-hosted runner labelled `incogniton`, and repository variables `INCOGNITON_TEST_PROFILE_ID` (+ optional `INCOGNITON_API_PORT`). See `.github/workflows/live.yml`.

GitHub CLI equivalents (run by a maintainer):

```bash
gh repo edit WorkingGreen/incogniton-automation-examples --description "Official Incogniton automation starter: runnable Playwright, Puppeteer, Python and Selenium examples with persistent sessions, diagnostics and verified results." --homepage https://api-docs.incogniton.com --template
```

```bash
gh repo edit WorkingGreen/incogniton-automation-examples --add-topic incogniton,antidetect-browser,browser-automation,playwright,puppeteer,selenium,cdp,web-automation,typescript,python,examples,starter-template
```
