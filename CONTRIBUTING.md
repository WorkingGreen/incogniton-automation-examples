# Contributing

Thanks for improving the Incogniton automation examples. Read [AGENTS.md](AGENTS.md) first: it lists the repository map and the rules every example follows (connect through Incogniton, persistent context, ownership, no fixed sleeps, no secrets in output).

## Workflow

1. Branch from `main`.
2. Make the change. For examples, follow [docs/extending.md](docs/extending.md) (source + npm script + manifest entry).
3. Run the static checks (no Incogniton app needed):

```bash
npm run check
```

4. Run the fixture tests (needs a Chromium: `npx playwright install chromium`):

```bash
npm run test:fixtures
```

5. If you have the Incogniton desktop app and a dedicated test profile, run the live verification for what you changed:

```bash
npm run test:live -- --only <example-id>
```

6. Open a pull request. Say which checks you ran and on which OS. Do not claim live verification you did not run.

## Python

```bash
python -m venv .venv
```

Then install with the venv's interpreter (`.venv\Scripts\python` on Windows, `.venv/bin/python` on macOS):

```bash
.venv/bin/python -m pip install -r requirements-dev.txt
```

```bash
.venv/bin/python -m ruff check
```

To update Python dependencies: change the pins in `requirements.txt`, install them into a fresh venv, regenerate `requirements.lock` with `python -m pip freeze` (keep the header comment), and run the Python examples live.

## Updating npm dependencies

Dependencies are pinned exactly and `package-lock.json` is committed. After changing a version: `npm install`, `npm run check`, `npm run test:fixtures`, and a full `npm run test:live` on a machine with the Incogniton app, then update the versions in `docs/validation-report.md`.

## Security and privacy

Never commit `.env`, `.incogniton/`, `output/`, real cookies, account exports, profile payloads or proxy credentials. `npm run check` includes a basic leak guard but is not a substitute for reviewing your diff.
