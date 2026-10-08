/**
 * Example workflow: replace the body of `run` with your own business logic.
 *
 * Rules of thumb:
 * - Use `page` / `context` (the profile's persistent context). Do not call
 *   browser.newContext(): that context is empty and its data is discarded.
 * - Wait for meaningful conditions (text, role, URL), not fixed sleeps.
 * - Throw (or use `check`) when the outcome is wrong; the runner records the
 *   failure, saves a screenshot and still stops the profile.
 * - Do not stop the profile yourself; the runner owns the lifecycle.
 */
import { check } from '../../../lib/run.js';
import type { Workflow } from './types.js';

export const exampleWorkflow: Workflow = {
  name: 'example',
  description: 'Open the fixture form, submit it and verify the confirmation.',
  async run({ page, fixtures, artifact, log }) {
    await page.goto(fixtures.url('form.html'));
    await page.getByLabel('Full name').fill('Starter User');
    await page.getByLabel('Plan').selectOption({ label: 'Free' });
    await page.getByLabel('I accept the fixture terms').check();
    await page.getByRole('button', { name: 'Submit' }).click();

    const expected = 'Submitted: Starter User (Free plan)';
    await page.getByRole('status').filter({ hasText: expected }).waitFor();
    check((await page.getByRole('status').textContent()) === expected, 'confirmation text mismatch');
    await page.screenshot({ path: artifact('example-workflow.png') });
    log('form submitted');

    return { summary: `Example workflow passed: "${expected}"`, details: { confirmation: expected } };
  },
};
