"""Launch an Incogniton profile, connect Playwright for Python, take a verified screenshot, stop the profile.

Run (from the repository root, with the Python environment set up as in README):
    python examples/python/playwright/launch_profile_and_screenshot.py [--profile-id <id>] [--headed]
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/python

from playwright.async_api import Browser, async_playwright
from starter_common import (
    Run,
    common_parser,
    config_or_exit,
    create_client,
    launch_for_cdp,
    shutdown_owned_profile,
    start_fixture_server,
)


async def main() -> int:
    _, config = config_or_exit(common_parser("Launch a profile and take a screenshot with Playwright for Python."))
    run = Run("python-launch-profile-and-screenshot", "playwright", config)
    client = create_client(config)  # official SDK: IncognitonClient(port=...)
    fixtures = start_fixture_server(config)
    summary, failure = None, None
    browser: Browser | None = None
    launched = False
    try:
        async with async_playwright() as playwright:
            try:
                # 1-2. Check the profile is Ready, launch it for CDP, wait for the endpoint.
                cdp_url = await launch_for_cdp(client, config)
                launched = True
                # 3. Connect over CDP (bounded attempts, see lib/playwright-session.ts for why).
                for attempt in range(1, 4):
                    try:
                        browser = await playwright.chromium.connect_over_cdp(cdp_url, timeout=10_000)
                        break
                    except Exception:
                        if attempt == 3:
                            raise
                assert browser is not None
                run.browser_version = browser.version
                # 4. The profile's persistent DEFAULT context. browser.new_page()/new_context()
                #    would create a fresh context without the profile's cookies and storage.
                context = browser.contexts[0]
                context.set_default_timeout(config.action_timeout_ms)
                page = await context.new_page()
                try:
                    await page.goto(fixtures.url("index.html"))
                    await page.get_by_role("status").filter(has_text="Fixture ready").wait_for()
                    heading = await page.get_by_role("heading", level=1).text_content()
                    assert heading == "Incogniton automation fixture", f"unexpected heading {heading!r}"
                    user_agent = await page.locator("#user-agent").text_content() or ""
                    assert "Chrome/" in user_agent, f"unexpected user agent {user_agent!r}"
                    await page.screenshot(path=str(run.artifact("screenshot.png")), full_page=True)
                    summary = f"{browser.version} rendered the fixture; screenshot saved."
                except BaseException:
                    await page.screenshot(path=str(run.artifact("failure.png")), full_page=True)
                    raise
                finally:
                    await page.close()  # Chrome restores open tabs next launch; don't leave ours
            finally:
                if launched:
                    # 6. Graceful: CDP Browser.close lets Chrome flush storage; wait for Ready.
                    async def close_browser() -> None:
                        if browser is not None:
                            cdp = await browser.new_browser_cdp_session()
                            await cdp.send("Browser.close")

                    run.cleanup.append(await shutdown_owned_profile(client, config, close_browser))
    except BaseException as error:  # noqa: BLE001 - recorded in result.json
        failure = error
    finally:
        fixtures.close()
    return run.finish(summary, failure, None)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
