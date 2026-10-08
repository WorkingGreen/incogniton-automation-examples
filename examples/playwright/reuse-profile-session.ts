// Prove that cookies, localStorage and IndexedDB persist in an Incogniton profile across
// separate runs. Phase "write" stores test values and shuts down gracefully; phase "verify"
// is a separate process that relaunches the same profile and reads them back.
// Run: npm run example:persistence            (runs write, then verify, as two processes)
//      npm run example:persistence -- --phase write|verify|reset
import { spawnSync } from 'node:child_process';
import { requireProfileId } from '../../lib/config.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { check, runExample } from '../../lib/run.js';

const phase = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'all';

if (phase === 'all') {
  // Two separate OS processes, so nothing can survive in this process's memory.
  for (const step of ['write', 'verify']) {
    console.log(`\n=== reuse-profile-session: phase ${step} (separate process) ===`);
    const args = process.argv.slice(2).filter((arg, i, all) => arg !== '--phase' && all[i - 1] !== '--phase');
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, '--phase', step, ...args], { stdio: 'inherit' });
    if (child.status !== 0) {
      process.exitCode = child.status ?? 1;
      break;
    }
  }
} else {
  await runExample(
    {
      id: `reuse-profile-session-${phase}`,
      framework: 'playwright',
      description: 'Write (or verify / reset) test cookies, localStorage and IndexedDB in a profile.',
    },
    { phase: { type: 'string' }, value: { type: 'string' } },
    async ({ config, flags, artifact, manage, onCleanup, log, signal }) => {
      if (!['write', 'verify', 'reset'].includes(phase!)) throw new Error(`Unknown --phase "${phase}" (use write, verify or reset)`);
      // Storage belongs to an origin, so the fixture must use the same host and port every run.
      const fixtures = await startFixtureServer(config);
      onCleanup(() => fixtures.close());
      const session = manage(await openPlaywrightSession(config, { profileId: requireProfileId(config), log, signal }));
      // The profile's persistent DEFAULT context: this is where its data lives.
      const { context, page } = session;
      await page.goto(fixtures.url('storage.html'));
      const value = String(flags.value ?? 'persisted-by-incogniton-starter');

      if (phase === 'write') {
        await context.addCookies([
          { name: 'starter_cookie', value, url: fixtures.origin, expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 },
        ]);
        await page.evaluate(async (v) => {
          localStorage.setItem('starter_local', v);
          await new Promise<void>((resolve, reject) => {
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
        }, value);
        // A separate, non-persistent context does NOT share the profile's storage.
        const scratch = await session.browser.newContext();
        const scratchPage = await scratch.newPage();
        await scratchPage.goto(fixtures.url('storage.html'));
        const scratchLocal = await scratchPage.evaluate(() => localStorage.getItem('starter_local'));
        await scratch.close();
        check(scratchLocal === null, 'a new browser.newContext() unexpectedly saw the profile localStorage');
        await page.reload();
        await page.screenshot({ path: artifact('written.png') });
        // runExample's cleanup closes the browser gracefully (CDP Browser.close) so Chrome
        // flushes cookies and localStorage before the app runs its stop/sync pipeline.
        return {
          summary: `Wrote cookie, localStorage and IndexedDB value "${value}" for ${fixtures.origin}. Run phase "verify" next.`,
          details: { origin: fixtures.origin, value, newContextSawProfileStorage: false },
        };
      }

      if (phase === 'reset') {
        // Remove only fixture-owned test data; other data in the profile is untouched.
        await context.clearCookies({ name: 'starter_cookie' });
        await page.evaluate(async () => {
          localStorage.removeItem('starter_local');
          await new Promise((resolve) => { const r = indexedDB.deleteDatabase('starter_db'); r.onsuccess = r.onerror = r.onblocked = resolve; });
        });
        return { summary: `Removed starter_cookie, starter_local and starter_db for ${fixtures.origin}.` };
      }

      // verify
      const cookies = await context.cookies(fixtures.origin);
      const cookie = cookies.find((c) => c.name === 'starter_cookie')?.value ?? null;
      const local = await page.evaluate(() => localStorage.getItem('starter_local'));
      const idb = await page.evaluate(
        () =>
          new Promise<string | null>((resolve) => {
            const open = indexedDB.open('starter_db', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('kv');
            open.onsuccess = () => {
              const get = open.result.transaction('kv').objectStore('kv').get('starter_idb');
              get.onsuccess = () => { open.result.close(); resolve((get.result as string | undefined) ?? null); };
              get.onerror = () => resolve(null);
            };
            open.onerror = () => resolve(null);
          }),
      );
      await page.reload();
      await page.screenshot({ path: artifact('verified.png') });
      const verified = { cookie: cookie === value, localStorage: local === value, indexedDB: idb === value };
      check(verified.cookie && verified.localStorage && verified.indexedDB, `values after relaunch: cookie=${cookie} localStorage=${local} indexedDB=${idb} (expected "${value}")`);
      return { summary: `Cookie, localStorage and IndexedDB values survived a full profile stop and relaunch.`, details: { origin: fixtures.origin, verified } };
    },
  );
}
