/**
 * Diagnostics demo: waits for an element that never appears, so you can see what a
 * failing run produces (exit code 10, failure screenshot, result.json with the error,
 * and the profile still stopped cleanly).
 *   npm start -- --workflow failure-demo
 */
import type { Workflow } from './types.js';

export const failureDemoWorkflow: Workflow = {
  name: 'failure-demo',
  description: 'Deliberately times out to demonstrate failure artifacts and cleanup.',
  async run({ page, fixtures }) {
    await page.goto(fixtures.url('index.html'));
    await page.getByRole('status').filter({ hasText: 'Fixture ready' }).waitFor();
    await page.getByRole('button', { name: 'This button does not exist' }).click({ timeout: 2000 });
    return { summary: 'unreachable' };
  },
};
