# Running Incogniton automation unattended

## What "headless" does and does not mean

- `INCOGNITON_HEADLESS=true` (or `--headless`) adds `--headless=new` to the **profile browser's** command line. The browser then has no window.
- It does **not** make the Incogniton desktop application headless. The automation API exists only while the desktop app is running and logged in. It is a desktop (GUI) application for Windows and macOS. It is not a background service, a CLI daemon, or a Linux/container image.

So an unattended setup is: a Windows or macOS machine, with a user session in which the Incogniton app is running and logged in, and a scheduler that runs your script in that same user session.

## Requirements checklist

1. Supported host: Windows or macOS. Verified for this repository: Windows Server 2022 x64 (see [compatibility.json](compatibility.json)). Linux, Docker and hosted CI runners cannot run the desktop app.
2. The Incogniton app is running and logged in, with automation enabled (Settings → Automation) on a plan that includes automation.
3. The script runs as the **same OS user**, in that user's session (the API listens on `127.0.0.1` only).
4. `npm run doctor` passes in that context (run it once from the scheduler to be sure).

## After a reboot

Nothing in this repository starts or logs in the Incogniton app. After a reboot, someone (or your OS auto-login plus the app's own start-up behaviour) must start the app and log in before scheduled runs can succeed. Until then runs fail fast with exit code 3 (`api_unreachable`), which a scheduler can alert on. Whether the app can restore a logged-in session automatically after a restart was not verified here; check it on your machine.

## Repeating runs without a scheduler

The starter has a bounded, non-overlapping repeat mode:

```bash
npm start -- --repeat 12 --interval 300
```

- Runs the registered workflow 12 times, waiting 300 s between the end of one run and the start of the next. Runs never overlap.
- Each run launches and stops the profile and writes its own `output/starter/<timestamp>/result.json`.
- Stops early after a failed run (non-zero exit code).
- Ctrl+C cancels the current run, still stops the profile, and starts no further runs.

## Windows Task Scheduler

Create a task that runs only when the user is logged on (so it runs in the session where the app is), every hour:

```bash
schtasks /Create /TN "Incogniton starter" /SC HOURLY /IT /TR "cmd /c cd /d C:\path\to\incogniton-automation-examples && npm start >> output\scheduler.log 2>&1"
```

- `/IT` = run only when the user is logged on (interactive). The default "If the task is already running: Do not start a new instance" setting prevents overlapping runs from the scheduler. The per-profile lock (`.incogniton/locks/`) additionally rejects a second process of this checkout using the same profile (exit 5).
- Check the task's "Last Run Result": it is the exit code from [troubleshooting](troubleshooting.md#exit-codes).

## macOS launchd (user agent)

Save as `~/Library/LaunchAgents/com.example.incogniton-starter.plist` (adjust paths), then load it with `launchctl load ~/Library/LaunchAgents/com.example.incogniton-starter.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.incogniton-starter</string>
  <key>WorkingDirectory</key><string>/Users/you/incogniton-automation-examples</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/npm</string><string>start</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>/Users/you/incogniton-automation-examples/output/scheduler.log</string>
  <key>StandardErrorPath</key><string>/Users/you/incogniton-automation-examples/output/scheduler.log</string>
</dict>
</plist>
```

A LaunchAgent runs in the logged-in user's GUI session, where the app runs. launchd does not start a second instance of a job while one is still running. The macOS recipe is documented but has not been verified by this repository.

## Monitoring

- Exit codes are stable ([table](troubleshooting.md#exit-codes)); alert on non-zero.
- `result.json` per run contains the failure kind, sanitized message, cleanup outcome and artifact paths ([schema](result-schema.md)).
- `npm run doctor -- --json` is a cheap health probe for the app/API before a batch.

## Things to avoid

- Running the script as a different user, as a Windows service, or from a container: the API on `127.0.0.1` belongs to the logged-in user's app.
- Using `profile.stop()`/force-stop as the normal shutdown: recent cookies/localStorage can be lost (see [lifecycle](lifecycle-and-persistence.md)).
- Re-launching on every error: launches are not idempotent, and launching an open profile fails. Fix the cause, or let the next scheduled run retry.
