"""Launch an Incogniton profile for Selenium, fill a form, take a screenshot, stop the profile.

Incogniton's Selenium path differs from CDP: the app starts the browser and exposes a
WebDriver endpoint through its local Selenium grid (default port 4444). No chromedriver is
needed on your side. driver.quit() ends the WebDriver session and the app stops the browser.

Run:
    python examples/python/selenium/launch_profile_and_screenshot.py [--profile-id <id>] [--headed]
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from selenium import webdriver
from selenium.common.exceptions import InvalidSessionIdException, TimeoutException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.select import Select
from selenium.webdriver.support.ui import WebDriverWait
from starter_common import (
    Run,
    StarterError,
    common_parser,
    config_or_exit,
    create_client,
    get_status,
    start_fixture_server,
    wait_until_ready,
)


async def main() -> int:
    _, config = config_or_exit(common_parser("Launch a profile with Selenium, fill a form and take a screenshot."))
    run = Run("python-selenium-launch-profile-and-screenshot", "selenium", config)
    client = create_client(config)
    fixtures = start_fixture_server(config)
    summary, failure, details = None, None, None
    driver = None
    launched = False
    try:
        await wait_until_ready(client, config.profile_id, time.monotonic() + config.launch_timeout_s)
        # SDK: automation.launch_selenium_custom(profile_id, custom_args)
        # -> POST /automation/launch/python/{id}/ ; returns {"status":"ok","url":"127.0.0.1:4444/<id>"}.
        # Headless must be requested here: the app launches the browser, not WebDriver.
        response = await client.automation.launch_selenium_custom(config.profile_id, "--headless=new" if config.headless else "")
        if response.get("status") != "ok" or not response.get("url"):
            raise StarterError("launch_failed", f"Selenium launch failed: {response.get('message', response.get('status'))}")
        launched = True
        driver = webdriver.Remote(command_executor=f"http://{response['url']}", options=Options())
        run.browser_version = driver.capabilities.get("browserVersion")
        # Bounded page loads (WebDriver's default is 300 s). On the tested host, navigations on the
        # Incogniton Selenium path intermittently never completed; fail fast with a clear message.
        driver.set_page_load_timeout(config.action_timeout_ms / 1000)
        wait = WebDriverWait(driver, config.action_timeout_ms / 1000)

        # Open our own tab so the profile's restored tabs are left as they were.
        driver.switch_to.new_window("tab")
        try:
            driver.get(fixtures.url("form.html"))
        except (TimeoutException, InvalidSessionIdException) as error:
            raise StarterError(
                "timeout",
                f"Navigation did not complete: {str(error).splitlines()[0]}",
                hint="Known intermittent issue on the Incogniton Selenium path (see docs/product-and-documentation-gaps.md). "
                "Run again; the CDP-based Python Playwright example is not affected.",
            ) from error
        driver.find_element(By.ID, "full-name").send_keys("Ada Lovelace")
        Select(driver.find_element(By.ID, "plan")).select_by_visible_text("Pro")
        driver.find_element(By.ID, "terms").click()
        driver.find_element(By.CSS_SELECTOR, "button[type=submit]").click()
        expected = "Submitted: Ada Lovelace (Pro plan)"
        wait.until(EC.text_to_be_present_in_element((By.ID, "result"), expected))
        result_text = driver.find_element(By.ID, "result").text
        assert result_text == expected, f"result was {result_text!r}"
        driver.save_screenshot(str(run.artifact("form-submitted.png")))
        driver.close()  # close our tab (Chrome restores open tabs next launch)
        summary = f"Selenium filled and submitted the form in {run.browser_version}: {result_text!r}"
        details = {"resultText": result_text}
    except BaseException as error:  # noqa: BLE001
        failure = error
        if driver is not None:
            try:
                driver.save_screenshot(str(run.artifact("failure.png")))
            except Exception:
                pass
    finally:
        if launched:
            started = time.monotonic()
            report = {"profileId": config.profile_id, "method": "webdriver-quit", "ok": False, "warnings": []}
            try:
                if driver is not None:
                    await asyncio.to_thread(driver.quit)  # ends the session; the app then stops the browser
                status = await get_status(client, config.profile_id)
                while status != "Ready" and time.monotonic() - started < config.stop_timeout_s:
                    if time.monotonic() - started > 30 and status == "Launched" and report["method"] == "webdriver-quit":
                        report["method"] = "api-stop"
                        report["warnings"].append("browser still running 30 s after quit; used profile.stop()")
                        await client.profile.stop(config.profile_id)
                    await asyncio.sleep(0.5)
                    status = await get_status(client, config.profile_id)
                report.update(finalStatus=status, ok=status == "Ready")
            except Exception as error:
                report["error"] = str(error)[:500]
            report["durationMs"] = int((time.monotonic() - started) * 1000)
            run.cleanup.append(report)
        fixtures.close()
    return run.finish(summary, failure, details)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
