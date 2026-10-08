# Changelog

All notable changes to this repository. Versions are tags of the examples repository, not of the Incogniton SDKs.

## [Unreleased]

### Added

- Minimal self-contained Playwright and Puppeteer screenshot examples (official `incogniton@1.0.17` npm SDK).
- Playwright examples: form interaction, persistence across separate runs (cookies, localStorage, IndexedDB), same- and cross-origin iframes, canvas game control with screenshot-based observation, bounded multi-profile runs, attach to a running session, temporary profile creation/cleanup, paginated extraction, file upload/download, network interception.
- Puppeteer persistence example; Python Playwright screenshot and persistence examples; Python Selenium form example (official `incogniton==0.3.0` PyPI SDK).
- Starter application with workflow registry, bounded repeat mode and failure demo.
- `npm run setup` (interactive and non-interactive), `npm run doctor` (text/JSON), `npm run profiles`, `npm run session`, `npm run fixtures`.
- Shared lifecycle helpers: status preflight, envelope checks, CDP readiness, bounded connect retries, graceful shutdown with fallback, host-local profile locks, sanitized diagnostics and `result.json` per run.
- Generated documentation pages, `examples/index.json` manifest with schema, `llms.txt`/`llms-full.txt`, compatibility data and live verification runner.
- CI for static checks, fixture tests and Python lint; manual live-verification workflow for a self-hosted runner.
