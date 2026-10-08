// Fill a text field, choose a select option, tick a checkbox, submit, and verify the result
// in an Incogniton profile using Playwright's semantic locators and auto-waiting.
// Run: npm run example:form
import { requireProfileId } from '../../lib/config.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { check, runExample } from '../../lib/run.js';

await runExample(
  { id: 'click-and-fill-form', framework: 'playwright', description: 'Fill and submit a form in an Incogniton profile and verify the result.' },
  { name: { type: 'string', default: 'Ada Lovelace' } },
  async ({ config, flags, artifact, manage, onCleanup, log, signal }) => {
    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());

    // Launch the profile and connect Playwright to its persistent default context.
    const session = manage(await openPlaywrightSession(config, { profileId: requireProfileId(config), log, signal }));
    const { page } = session;

    await page.goto(fixtures.url('form.html'));
    const name = String(flags.name);

    // Semantic locators: by accessible label/role, not CSS structure.
    await page.getByLabel('Full name').fill(name);
    await page.getByLabel('Plan').selectOption({ label: 'Pro' });
    await page.getByLabel('I accept the fixture terms').check();
    await page.screenshot({ path: artifact('before-submit.png') });
    await page.getByRole('button', { name: 'Submit' }).click();

    // Wait for the final state (the fixture shows "Submitting…" first).
    const result = page.getByRole('status');
    const expected = `Submitted: ${name} (Pro plan)`;
    await result.filter({ hasText: expected }).waitFor();
    const text = await result.textContent();
    check(text === expected, `result text was "${text}", expected "${expected}"`);
    await page.screenshot({ path: artifact('after-submit.png') });

    return { summary: `Form submitted and verified: "${text}"`, details: { resultText: text } };
  },
);
