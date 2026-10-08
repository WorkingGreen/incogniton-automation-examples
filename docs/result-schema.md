# `result.json` schema (version 1)

Every example run (TypeScript and Python) writes `output/<example-id>/<UTC timestamp>-<random>/result.json` plus a human-readable `summary.txt`. The format is stable within `schemaVersion: 1`; fields are only added, never renamed.

| Field | Type | Description |
| --- | --- | --- |
| `schemaVersion` | `1` | Format version |
| `exampleId` | string | e.g. `click-and-fill-form`, `reuse-profile-session-verify`, `python-launch-profile-and-screenshot` |
| `language` | `typescript` \| `python` | |
| `framework` | `playwright` \| `puppeteer` \| `selenium` | |
| `status` | `passed` \| `passed_with_cleanup_failure` \| `failed` \| `cancelled` | |
| `exitCode` | number | Process exit code ([table](troubleshooting.md#exit-codes)) |
| `startedAt` | ISO 8601 string | |
| `durationMs` | number | Whole run including launch and cleanup |
| `summary` | string \| null | One line describing the verified outcome |
| `failure` | object \| null | `{ kind, message, hint }`; `message` is sanitized and truncated |
| `details` | object \| null | Example-specific, non-sensitive facts (e.g. verified storage types) |
| `profiles` | array | `{ label, profileId }` for every managed session (TypeScript) |
| `cleanup` | array | One report per stopped/detached session: `{ profileId, method: graceful \| api-stop \| detached \| webdriver-quit \| none, ok, sawSyncStatus, finalStatus, durationMs, warnings[], error? }` |
| `consoleErrors` | string[] | Browser console errors and uncaught page errors (TypeScript; max 50, sanitized) |
| `artifacts` | string[] | Repository-relative paths of screenshots and files from this run |
| `versions` | object | `node`/`python`, `platform`, `incognitonSdk`, framework package version, `browsers` (e.g. `Chrome/152.0.7977.54`) |
| `config` | object | `{ apiPort, headless }`. No profile data, cookies, proxy details or tokens are recorded |

Example (abridged):

```json
{
  "schemaVersion": 1,
  "exampleId": "click-and-fill-form",
  "language": "typescript",
  "framework": "playwright",
  "status": "passed",
  "exitCode": 0,
  "durationMs": 6712,
  "summary": "Form submitted and verified: \"Submitted: Ada Lovelace (Pro plan)\"",
  "failure": null,
  "cleanup": [{ "profileId": "<id>", "method": "graceful", "ok": true, "sawSyncStatus": true, "finalStatus": "Ready", "durationMs": 3030, "warnings": [] }],
  "artifacts": ["output/click-and-fill-form/20261008-075655-d2cf/before-submit.png", "output/click-and-fill-form/20261008-075655-d2cf/after-submit.png"],
  "versions": { "node": "v22.23.3", "platform": "win32-x64", "incognitonSdk": "1.0.17", "playwrightCore": "1.64.0", "browsers": ["Chrome/152.0.7977.54"] }
}
```

The self-contained minimal examples (`launch-profile-and-screenshot`, `puppeteer-launch-profile-and-screenshot`) intentionally skip this bookkeeping and print `PASS:`/`FAIL:` with exit code 0/1.
