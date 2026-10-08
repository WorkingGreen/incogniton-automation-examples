# `npm run doctor`

Checks what can actually be checked before you run examples. It never guesses: things the local API cannot tell are reported as `unknown`.

```bash
npm run doctor
```

```bash
npm run doctor -- --json
```

```bash
npm run doctor -- --launch
```

`--launch` additionally launches the configured profile, connects Playwright, and stops it gracefully. `--profile-id <id>` and `--port <port>` override `.env`.

## Checks

| id | Passes when | Status if not |
| --- | --- | --- |
| `node` | Node.js ≥ 22.12 | fail (exit 2) |
| `dependencies` | `node_modules` matches the exact versions in package.json | fail (exit 2): run `npm ci` |
| `env_file` | `.env` exists | warn |
| `config` | all configuration values are valid | fail (exit 2) |
| `api_reachable` | `GET /alive` on `127.0.0.1:<port>` returns `OK` | fail (exit 3) |
| `api_profiles` | `GET /profile/all/` returns a `profileData` array | fail (exit 9) |
| `app_version` | — | always `unknown`: the API has no version endpoint |
| `automation_entitlement` | — | always `unknown`: not queryable; a reachable API implies automation is enabled for this login |
| `profile` | the configured profile exists and is `Ready` | warn if not set or not `Ready`; fail (exit 4) if it does not exist |
| `launch_connect` | (with `--launch`) launch + connect + graceful stop succeeded | fail with the launch/connect kind; `skip` without `--launch` |

## JSON output (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "ok": true,
  "exitCode": 0,
  "generatedAt": "2026-10-08T08:30:00.000Z",
  "checks": [
    { "id": "api_reachable", "status": "pass", "message": "GET /alive on 127.0.0.1:35000 returned OK" },
    { "id": "app_version", "status": "unknown", "message": "The local API exposes no app version endpoint; not checked." }
  ]
}
```

- `status` is one of `pass`, `warn`, `fail`, `unknown`, `skip`.
- `ok` is `false` when any check has `status: "fail"`. `exitCode` is then the code of the first failing check (see [exit codes](troubleshooting.md#exit-codes)).
- Checks may include `hint` (what to do) and `data` (non-sensitive values such as the profile count or browser version).
