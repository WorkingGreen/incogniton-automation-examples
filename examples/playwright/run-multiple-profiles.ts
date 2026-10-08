// Run the same workflow in several Incogniton profiles concurrently, with a small limit.
// Each worker owns its profile lifecycle, context, output directory and result.
// Run: npm run example:multi -- --profile-ids <id1>,<id2> [--concurrency 2]
//      (or set INCOGNITON_PROFILE_IDS and MAX_CONCURRENCY in .env)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StarterError, sanitize } from '../../lib/errors.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { runExample } from '../../lib/run.js';

interface WorkerResult {
  profileId: string;
  ok: boolean;
  durationMs: number;
  resultText?: string;
  screenshot?: string;
  cleanup?: string;
  error?: string;
}

/** Runs `tasks` with at most `limit` in flight. Results keep input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

await runExample(
  { id: 'run-multiple-profiles', framework: 'playwright', description: 'Run a workflow across distinct profiles with bounded concurrency.' },
  { 'profile-ids': { type: 'string' }, concurrency: { type: 'string' } },
  async ({ config, flags, runDir, artifact, manage, onCleanup, log, signal }) => {
    const ids = flags['profile-ids'] ? String(flags['profile-ids']).split(',').map((id) => id.trim()).filter(Boolean) : config.profileIds;
    if (ids.length === 0) {
      throw new StarterError('config_invalid', 'No profiles given.', { hint: 'Pass --profile-ids <id1>,<id2> or set INCOGNITON_PROFILE_IDS in .env.' });
    }
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (duplicates.length > 0) {
      // One browser per profile: the same profile cannot run twice at once.
      throw new StarterError('config_invalid', `Duplicate profile IDs: ${[...new Set(duplicates)].join(', ')}`);
    }
    const concurrency = flags.concurrency ? Number(flags.concurrency) : config.maxConcurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new StarterError('config_invalid', '--concurrency must be a positive integer');

    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());
    log(`running ${ids.length} profile(s) with concurrency ${concurrency}`);

    const results = await mapWithConcurrency(ids, concurrency, async (profileId): Promise<WorkerResult> => {
      const started = Date.now();
      const workerLog = (message: string) => log(`[${profileId.slice(0, 8)}] ${message}`);
      const workerDir = join(runDir, profileId);
      mkdirSync(workerDir, { recursive: true });
      let session;
      try {
        // A per-process lock (see lib/profile-lock.ts) stops overlapping jobs for one profile.
        session = manage(await openPlaywrightSession(config, { profileId, log: workerLog, signal }), profileId);
        const { page } = session;
        await page.goto(fixtures.url('form.html'));
        await page.getByLabel('Full name').fill(`Worker ${profileId.slice(0, 8)}`);
        await page.getByLabel('Plan').selectOption({ label: 'Team' });
        await page.getByLabel('I accept the fixture terms').check();
        await page.getByRole('button', { name: 'Submit' }).click();
        const expected = `Submitted: Worker ${profileId.slice(0, 8)} (Team plan)`;
        await page.getByRole('status').filter({ hasText: expected }).waitFor();
        const screenshot = join(workerDir, 'result.png');
        await page.screenshot({ path: screenshot });
        const cleanup = await session.close(); // stop this worker's own profile as soon as it is done
        return { profileId, ok: cleanup.ok, durationMs: Date.now() - started, resultText: expected, screenshot, cleanup: `${cleanup.method}/${cleanup.finalStatus}`, error: cleanup.error };
      } catch (error) {
        const cleanup = session ? await session.close() : undefined;
        return { profileId, ok: false, durationMs: Date.now() - started, cleanup: cleanup ? `${cleanup.method}/${cleanup.finalStatus}` : 'not launched', error: sanitize((error as Error).message, 300) };
      }
    });

    writeFileSync(artifact('workers.json'), `${JSON.stringify(results, null, 2)}\n`);
    const failed = results.filter((r) => !r.ok);
    for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'} ${r.profileId} in ${(r.durationMs / 1000).toFixed(1)}s${r.error ? `: ${r.error}` : ''}`);
    if (failed.length > 0) {
      throw new StarterError('workflow_failed', `${failed.length} of ${results.length} profile job(s) failed: ${failed.map((r) => r.profileId).join(', ')}`);
    }
    return { summary: `All ${results.length} profile jobs passed (concurrency ${concurrency}).`, details: { concurrency, results } };
  },
);
