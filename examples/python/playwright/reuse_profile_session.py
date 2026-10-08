"""Prove cookies, localStorage and IndexedDB persist in an Incogniton profile across separate runs.

Phase "write" stores test values and closes the browser gracefully; phase "verify" (a separate
process) relaunches the same profile and reads them back. Phase "reset" removes only the test values.

Run:
    python examples/python/playwright/reuse_profile_session.py                 # write, then verify
    python examples/python/playwright/reuse_profile_session.py --phase verify
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from playwright.async_api import Browser, async_playwright
from starter_common import (
    Run,
    StarterError,
    common_parser,
    config_or_exit,
    create_client,
    launch_for_cdp,
    shutdown_owned_profile,
    start_fixture_server,
)

WRITE_JS = """async (v) => {
  localStorage.setItem('starter_local', v);
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('starter_db', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, 'starter_idb');
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}"""

READ_IDB_JS = """() => new Promise((resolve) => {
  const open = indexedDB.open('starter_db', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onsuccess = () => {
    const get = open.result.transaction('kv').objectStore('kv').get('starter_idb');
    get.onsuccess = () => { open.result.close(); resolve(get.result ?? null); };
    get.onerror = () => resolve(null);
  };
  open.onerror = () => resolve(null);
})"""

RESET_JS = """async () => {
  localStorage.removeItem('starter_local');
  await new Promise((resolve) => { const r = indexedDB.deleteDatabase('starter_db'); r.onsuccess = r.onerror = r.onblocked = resolve; });
}"""


async def run_phase(phase: str, value: str, args_config) -> int:
    _, config = args_config
    run = Run(f"python-reuse-profile-session-{phase}", "playwright", config)
    client = create_client(config)
    fixtures = start_fixture_server(config)  # fixed port => same storage origin every run
    summary, failure, details = None, None, None
    browser: Browser | None = None
    launched = False
    try:
        async with async_playwright() as playwright:
            try:
                cdp_url = await launch_for_cdp(client, config)
                launched = True
                for attempt in range(1, 4):
                    try:
                        browser = await playwright.chromium.connect_over_cdp(cdp_url, timeout=10_000)
                        break
                    except Exception:
                        if attempt == 3:
                            raise
                assert browser is not None
                run.browser_version = browser.version
                context = browser.contexts[0]  # persistent default context = the profile's data
                context.set_default_timeout(config.action_timeout_ms)
                page = await context.new_page()
                try:
                    await page.goto(fixtures.url("storage.html"))
                    if phase == "write":
                        await context.add_cookies(
                            [{"name": "starter_cookie", "value": value, "url": fixtures.origin, "expires": int(time.time()) + 7 * 24 * 3600}]
                        )
                        await page.evaluate(WRITE_JS, value)
                        await page.reload()
                        await page.screenshot(path=str(run.artifact("written.png")))
                        summary = f"Wrote cookie, localStorage and IndexedDB value {value!r} for {fixtures.origin}."
                    elif phase == "reset":
                        await context.clear_cookies(name="starter_cookie")
                        await page.evaluate(RESET_JS)
                        summary = "Removed starter_cookie, starter_local and starter_db."
                    else:
                        cookies = await context.cookies(fixtures.origin)
                        cookie = next((c["value"] for c in cookies if c["name"] == "starter_cookie"), None)
                        local = await page.evaluate("() => localStorage.getItem('starter_local')")
                        idb = await page.evaluate(READ_IDB_JS)
                        await page.screenshot(path=str(run.artifact("verified.png")))
                        details = {"cookie": cookie == value, "localStorage": local == value, "indexedDB": idb == value}
                        if not all(details.values()):
                            raise StarterError(
                                "workflow_failed",
                                f"after relaunch: cookie={cookie!r} localStorage={local!r} indexedDB={idb!r} (expected {value!r})",
                            )
                        summary = "Cookie, localStorage and IndexedDB values survived a full profile stop and relaunch."
                finally:
                    await page.close()
            finally:
                if launched:

                    async def close_browser() -> None:
                        if browser is not None:
                            cdp = await browser.new_browser_cdp_session()
                            await cdp.send("Browser.close")

                    run.cleanup.append(await shutdown_owned_profile(client, config, close_browser))
    except BaseException as error:  # noqa: BLE001
        failure = error
    finally:
        fixtures.close()
    return run.finish(summary, failure, details)


def main() -> int:
    parser = common_parser("Write/verify/reset persistent test storage in an Incogniton profile.")
    parser.add_argument("--phase", choices=["all", "write", "verify", "reset"], default="all")
    parser.add_argument("--value", default="persisted-by-incogniton-starter-python")
    args, config = config_or_exit(parser)
    if args.phase != "all":
        return asyncio.run(run_phase(args.phase, args.value, (args, config)))
    # Two separate processes, so nothing can survive in memory between write and verify.
    forwarded = [a for i, a in enumerate(sys.argv[1:]) if a != "--phase" and (i == 0 or sys.argv[i] != "--phase")]
    for phase in ("write", "verify"):
        print(f"\n=== python reuse_profile_session: phase {phase} (separate process) ===", flush=True)
        code = subprocess.call([sys.executable, __file__, "--phase", phase, *forwarded])
        if code != 0:
            return code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
