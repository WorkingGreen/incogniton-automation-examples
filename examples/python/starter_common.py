"""Shared helpers for the Python examples (repository helpers, not Incogniton SDK methods).

Mirrors lib/*.ts of the TypeScript starter:
- configuration from .env / environment / flags with validation
- a local fixture server on fixed ports (stable storage origin across runs)
- lifecycle helpers around the official `incogniton` PyPI SDK (IncognitonClient)
- result.json / summary.txt per run in output/<example-id>/<timestamp>/

Runtime-verified behaviour (see docs/lifecycle-and-persistence.md):
- Launch responses report errors as {"status": "error", "message": ...} with HTTP 200.
- Launching an already-open profile fails, so the status is checked first.
- profile.stop() terminates the browser process; closing the browser over CDP
  ("Browser.close") lets Chrome flush storage and the app run its stop/sync pipeline.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import sys
import threading
import time
import urllib.request
from collections.abc import Awaitable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from incogniton import IncognitonClient

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = REPO_ROOT / "fixtures"
PROFILE_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
OPEN_STATUSES = {"Launched", "Launching", "Opened", "Launched on different device"}
TRANSIENT_STATUSES = {"Syncing", "Stopping", "Uploading", "Checking proxy", "Adding"}

# Exit codes shared with the TypeScript examples (docs/troubleshooting.md#exit-codes).
EXIT_CODES = {
    "ok": 0,
    "workflow_failed": 1,
    "config_invalid": 2,
    "api_unreachable": 3,
    "profile_not_found": 4,
    "profile_busy": 5,
    "launch_failed": 6,
    "connect_failed": 7,
    "cleanup_failed": 8,
    "api_error": 9,
    "timeout": 10,
    "unknown": 11,
    "cancelled": 130,
}


class StarterError(Exception):
    """An error with a failure kind (see EXIT_CODES) and an optional hint."""

    def __init__(self, kind: str, message: str, hint: str | None = None):
        super().__init__(message)
        self.kind = kind
        self.hint = hint


# ---------------------------------------------------------------- configuration


@dataclass
class Config:
    api_port: int
    profile_id: str
    headless: bool
    launch_timeout_s: float
    action_timeout_ms: int
    stop_timeout_s: float
    output_dir: Path
    fixture_port: int
    fixture_cross_origin_port: int


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].strip()
        values[key.strip()] = value
    return values


def common_parser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--profile-id", help="Incogniton profile ID (default: INCOGNITON_PROFILE_ID)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--headed", action="store_true", help="open a visible browser window")
    mode.add_argument("--headless", action="store_true", help="launch with --headless=new")
    parser.add_argument("--port", help="Incogniton API port (default: INCOGNITON_API_PORT or 35000)")
    return parser


def load_config(args: argparse.Namespace) -> Config:
    env = {**_read_env_file(REPO_ROOT / ".env"), **os.environ}
    problems: list[str] = []

    def get(name: str, default: str) -> str:
        value = env.get(name, "")
        return value.strip() if value.strip() else default

    def integer(name: str, default: str, low: int, high: int, override: str | None = None) -> int:
        text = override or get(name, default)
        try:
            value = int(text)
            if low <= value <= high:
                return value
        except ValueError:
            pass
        problems.append(f"{name}={text!r} must be an integer between {low} and {high}.")
        return int(default)

    profile_id = (args.profile_id or get("INCOGNITON_PROFILE_ID", "")).strip()
    if not profile_id:
        problems.append("INCOGNITON_PROFILE_ID is empty: run `npm run profiles -- list` or pass --profile-id.")
    elif not PROFILE_ID_RE.match(profile_id):
        problems.append(f"INCOGNITON_PROFILE_ID={profile_id!r} is not a profile ID (UUID).")
    headless_text = get("INCOGNITON_HEADLESS", "true").lower()
    if headless_text not in {"true", "false", "1", "0", "yes", "no"}:
        problems.append(f"INCOGNITON_HEADLESS={headless_text!r} must be true or false.")
    headless = headless_text in {"true", "1", "yes"}
    if args.headed:
        headless = False
    elif args.headless:
        headless = True
    config = Config(
        api_port=integer("INCOGNITON_API_PORT", "35000", 1, 65535, args.port),
        profile_id=profile_id,
        headless=headless,
        launch_timeout_s=integer("INCOGNITON_LAUNCH_TIMEOUT_MS", "120000", 5000, 3_600_000) / 1000,
        action_timeout_ms=integer("INCOGNITON_ACTION_TIMEOUT_MS", "15000", 1000, 600_000),
        stop_timeout_s=integer("INCOGNITON_STOP_TIMEOUT_MS", "120000", 5000, 3_600_000) / 1000,
        output_dir=REPO_ROOT / get("OUTPUT_DIR", "output"),
        fixture_port=integer("FIXTURE_PORT", "47811", 1024, 65535),
        fixture_cross_origin_port=integer("FIXTURE_CROSS_ORIGIN_PORT", "47812", 1024, 65535),
    )
    if problems:
        raise StarterError(
            "config_invalid", "Invalid configuration:\n  - " + "\n  - ".join(problems), hint="Fix .env (see .env.example) or run `npm run setup`."
        )
    return config


# ---------------------------------------------------------------- fixture server

REPORT_CSV = "id,name,score\n1,Ada,98\n2,Grace,95\n3,Linus,91\n"


class _FixtureHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, directory=str(FIXTURE_ROOT), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - quiet server
        return

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        path = self.path.split("?", 1)[0]
        if path == "/__fixture":
            return self._send(b'{"name":"incogniton-automation-fixtures","version":1}', "application/json")
        if path == "/api/quote":
            return self._send(b'{"text":"Served by the fixture server","source":"network"}', "application/json")
        if path == "/download/report.csv":
            return self._send(REPORT_CSV.encode(), "text/csv", {"Content-Disposition": 'attachment; filename="report.csv"'})
        return super().do_GET()


def _is_fixture_server(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/__fixture", timeout=1.5) as response:
            return json.loads(response.read()).get("name") == "incogniton-automation-fixtures"
    except Exception:
        return False


@dataclass
class FixtureServer:
    origin: str
    cross_origin: str
    servers: list[ThreadingHTTPServer] = field(default_factory=list)

    def url(self, path: str) -> str:
        return f"{self.origin}/{path.lstrip('/')}"

    def close(self) -> None:
        for server in self.servers:
            server.shutdown()
            server.server_close()


def start_fixture_server(config: Config) -> FixtureServer:
    """Serves ./fixtures on both fixture ports, reusing an already running fixture server."""
    fixture = FixtureServer(f"http://127.0.0.1:{config.fixture_port}", f"http://127.0.0.1:{config.fixture_cross_origin_port}")
    for port in (config.fixture_port, config.fixture_cross_origin_port):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), _FixtureHandler)
        except OSError:
            if _is_fixture_server(port):
                continue
            fixture.close()
            raise StarterError(
                "config_invalid", f"Fixture port {port} is in use by another program.", hint="Set FIXTURE_PORT / FIXTURE_CROSS_ORIGIN_PORT in .env."
            ) from None
        threading.Thread(target=server.serve_forever, daemon=True).start()
        fixture.servers.append(server)
    return fixture


# ---------------------------------------------------------------- Incogniton lifecycle


def create_client(config: Config) -> IncognitonClient:
    # SDK: IncognitonClient(port=...) targets http://localhost:<port>.
    # Note: incogniton 0.3.0 uses a fixed 35 s HTTP timeout per request.
    return IncognitonClient(port=config.api_port)


async def get_status(client: IncognitonClient, profile_id: str) -> str:
    try:
        response = await client.profile.get_status(profile_id)  # SDK
    except Exception as error:  # IncognitonError on connection problems
        if "Connection error" in str(error):
            raise StarterError(
                "api_unreachable",
                f"Incogniton API did not respond: {error}",
                hint="Start the Incogniton app, log in, check Settings > Automation. Run `npm run doctor`.",
            ) from error
        raise StarterError("api_error", f"Reading profile status failed: {error}") from error
    status = str(response.get("status", "unknown"))
    if status == "error":
        message = str(response.get("message", ""))
        kind = "profile_not_found" if re.search(r"no profile found|doesn't exist", message, re.I) else "api_error"
        raise StarterError(kind, f"Profile {profile_id}: {message}", hint="List profiles with `npm run profiles -- list`.")
    return status


async def wait_until_ready(client: IncognitonClient, profile_id: str, deadline: float) -> None:
    while True:
        status = await get_status(client, profile_id)
        if status == "Ready":
            return
        if status in OPEN_STATUSES:
            raise StarterError(
                "profile_busy",
                f"Profile {profile_id} is already open (status {status!r}).",
                hint="Close it in the Incogniton app (or stop the session that opened it) and retry.",
            )
        if status not in TRANSIENT_STATUSES:
            raise StarterError("launch_failed", f"Profile {profile_id} is not launchable (status {status!r}).")
        if time.monotonic() > deadline:
            raise StarterError("timeout", f"Profile stayed {status!r} until the launch deadline.")
        await asyncio.sleep(0.5)


def _classify_launch_message(message: str) -> tuple[str, str | None]:
    if re.search(r"doesn't exist|no profile found", message, re.I):
        return "profile_not_found", "List profiles with `npm run profiles -- list`."
    if re.search(r"already open|not in ready state|exited 21\b", message, re.I):
        return "profile_busy", "The profile is already running; close it first."
    return "launch_failed", None


def _http_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=2) as response:
        return json.loads(response.read())


async def launch_for_cdp(client: IncognitonClient, config: Config) -> str:
    """Launches the profile for CDP automation; returns the http://127.0.0.1:<port> endpoint."""
    deadline = time.monotonic() + config.launch_timeout_s
    await wait_until_ready(client, config.profile_id, deadline)
    # SDK: automation.launch_puppeteer_custom(profile_id, custom_args)
    # -> POST /automation/launch/puppeteer. The returned "puppeteerUrl" is a plain CDP endpoint.
    response = await client.automation.launch_puppeteer_custom(config.profile_id, "--headless=new" if config.headless else "")
    if response.get("status") != "ok" or not response.get("puppeteerUrl"):
        kind, hint = _classify_launch_message(str(response.get("message", response.get("status"))))
        raise StarterError(kind, f"Launch failed: {response.get('message', response.get('status'))}", hint=hint)
    cdp_url = str(response["puppeteerUrl"]).rstrip("/")
    try:
        # Wait for the DevTools endpoint, then for restored tabs to report a URL (see lib/incogniton.ts).
        while True:
            try:
                await asyncio.to_thread(_http_json, f"{cdp_url}/json/version")
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise StarterError("connect_failed", f"DevTools endpoint {cdp_url} did not answer in time.") from None
                await asyncio.sleep(0.2)
        previous = None
        settle_deadline = min(deadline, time.monotonic() + 8)
        while time.monotonic() < settle_deadline:
            try:
                pages = [t["url"] for t in await asyncio.to_thread(_http_json, f"{cdp_url}/json/list") if t.get("type") == "page"]
                if all(pages) and pages == previous:
                    break
                previous = pages
            except Exception:
                previous = None
            await asyncio.sleep(0.25)
        return cdp_url
    except BaseException:
        await client.profile.stop(config.profile_id)
        raise


async def shutdown_owned_profile(client: IncognitonClient, config: Config, request_graceful_close: Callable[[], Awaitable[None]]) -> dict[str, Any]:
    """Graceful close, wait for Ready, fall back to profile.stop(). Never force-stops."""
    started = time.monotonic()
    report: dict[str, Any] = {"profileId": config.profile_id, "method": "graceful", "ok": False, "sawSyncStatus": False, "warnings": []}
    try:
        try:
            await request_graceful_close()
        except Exception as error:  # the connection drops while closing; that is expected
            report["warnings"].append(f"graceful close request raised: {str(error)[:200]}")
        status = await get_status(client, config.profile_id)
        grace_deadline = started + 20
        while status != "Ready" and time.monotonic() < grace_deadline:
            report["sawSyncStatus"] |= status in TRANSIENT_STATUSES
            await asyncio.sleep(0.25)
            status = await get_status(client, config.profile_id)
        if status in OPEN_STATUSES:
            report["method"] = "api-stop"
            report["warnings"].append("browser did not exit after the graceful close; used profile.stop() (terminates the process)")
            await client.profile.stop(config.profile_id)  # SDK
        deadline = started + config.stop_timeout_s
        while status != "Ready" and time.monotonic() < deadline:
            report["sawSyncStatus"] |= status in TRANSIENT_STATUSES
            await asyncio.sleep(0.5)
            status = await get_status(client, config.profile_id)
        report["finalStatus"] = status
        report["ok"] = status == "Ready"
        if not report["ok"]:
            report["error"] = f"profile still {status!r} at the stop deadline"
    except Exception as error:
        report["error"] = str(error)[:500]
    report["durationMs"] = int((time.monotonic() - started) * 1000)
    return report


# ---------------------------------------------------------------- run bookkeeping


class Run:
    """Artifact directory + result.json for one example run."""

    def __init__(self, example_id: str, framework: str, config: Config):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self.dir = config.output_dir / example_id / f"{stamp}-{random.randrange(16**4):04x}"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.example_id = example_id
        self.framework = framework
        self.config = config
        self.started = time.monotonic()
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.artifacts: list[str] = []
        self.cleanup: list[dict[str, Any]] = []
        self.browser_version: str | None = None

    def artifact(self, name: str) -> Path:
        path = self.dir / name
        self.artifacts.append(path.relative_to(REPO_ROOT).as_posix())
        return path

    def finish(self, summary: str | None, failure: BaseException | None, details: dict[str, Any] | None = None) -> int:
        kind = "ok"
        if failure is not None:
            if isinstance(failure, StarterError):
                kind = failure.kind
            elif isinstance(failure, (KeyboardInterrupt, asyncio.CancelledError)):
                kind = "cancelled"
            else:
                kind = "unknown"
            if kind == "unknown" and isinstance(failure, AssertionError):
                kind = "workflow_failed"
            if kind == "unknown" and "Timeout" in type(failure).__name__:
                kind = "timeout"
        elif any(not c.get("ok") for c in self.cleanup):
            kind = "cleanup_failed"
        from importlib.metadata import PackageNotFoundError, version

        def pkg(name: str) -> str | None:
            try:
                return version(name)
            except PackageNotFoundError:
                return None

        if failure is None:
            status = "passed" if kind == "ok" else "passed_with_cleanup_failure"
        else:
            status = "cancelled" if kind == "cancelled" else "failed"
        result = {
            "schemaVersion": 1,
            "exampleId": self.example_id,
            "language": "python",
            "framework": self.framework,
            "status": status,
            "exitCode": EXIT_CODES[kind],
            "startedAt": self.started_at,
            "durationMs": int((time.monotonic() - self.started) * 1000),
            "summary": summary,
            "failure": None if failure is None else {"kind": kind, "message": str(failure)[:1000], "hint": getattr(failure, "hint", None)},
            "details": details,
            "cleanup": self.cleanup,
            "artifacts": self.artifacts,
            "versions": {
                "python": sys.version.split()[0],
                "platform": sys.platform,
                "incognitonSdk": pkg("incogniton"),
                "playwright": pkg("playwright") if self.framework == "playwright" else None,
                "selenium": pkg("selenium") if self.framework == "selenium" else None,
                "browsers": [self.browser_version] if self.browser_version else [],
            },
            "config": {"apiPort": self.config.api_port, "headless": self.config.headless},
        }
        result_path = self.dir / "result.json"
        result_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        lines = [f"{self.example_id}: {result['status'].upper()} in {result['durationMs'] / 1000:.1f}s"]
        if summary:
            lines.append(summary)
        if failure is not None:
            lines.append(f"failure ({kind}): {str(failure)[:1000]}")
            if getattr(failure, "hint", None):
                lines.append(f"hint: {failure.hint}")  # type: ignore[attr-defined]
        for c in self.cleanup:
            lines.append(f"cleanup {c['profileId']}: {'ok' if c.get('ok') else 'FAILED'} via {c['method']}, final status {c.get('finalStatus')}")
        lines += [f"artifact: {a}" for a in self.artifacts]
        (self.dir / "summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        print("\n" + "\n".join(lines) + f"\nresult: {result_path.relative_to(REPO_ROOT).as_posix()}")
        # One stable, machine-readable line for scripts and coding agents.
        cleanup_state = "none" if not self.cleanup else ("ok" if all(c.get("ok") for c in self.cleanup) else "failed")
        print(f"RESULT status={result['status']} exit={result['exitCode']} cleanup={cleanup_state} json={result_path}")
        return int(result["exitCode"])


def config_or_exit(parser: argparse.ArgumentParser) -> tuple[argparse.Namespace, Config]:
    args = parser.parse_args()
    try:
        return args, load_config(args)
    except StarterError as error:
        print(f"{error}\nhint: {error.hint}", file=sys.stderr)
        raise SystemExit(EXIT_CODES[error.kind]) from None
