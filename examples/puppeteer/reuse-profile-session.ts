// Puppeteer version of reuse-profile-session: phase "write" stores a cookie, localStorage and
// IndexedDB value and closes the browser gracefully; phase "verify" (a separate process)
// relaunches the same profile and reads them back.
// Run: npm run example:puppeteer:persistence     (write, then verify, as two processes)
//      npm run example:puppeteer:persistence -- --phase write|verify|reset
import { spawnSync } from 'node:child_process';
import { requireProfileId } from '../../lib/config.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { openPuppeteerSession } from '../../lib/puppeteer-session.js';
import { check, runExample } from '../../lib/run.js';

const phase = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'all';

if (phase === 'all') {
  for (const step of ['write', 'verify']) {
    console.log(`\n=== puppeteer reuse-profile-session: phase ${step} (separate process) ===`);
    const args = process.argv.slice(2).filter((arg, i, all) => arg !== '--phase' && all[i - 1] !== '--phase');
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, '--phase', step, ...args], { stdio: 'inherit' });
    if (child.status !== 0) {
      process.exitCode = child.status ?? 1;
      break;
    }
  }
} else {
  await runExample(
    { id: `puppeteer-reuse-profile-session-${phase}`, framework: 'puppeteer', description: 'Write (or verify / reset) test storage with Puppeteer.' },
    { phase: { type: 'string' }, value: { type: 'string' } },
    async ({ config, flags, artifact, manage, onCleanup, log, signal }) => {
      if (!['write', 'verify', 'reset'].includes(phase!)) throw new Error(`Unknown --phase "${phase}" (use write, verify or reset)`);
      const fixtures = await startFixtureServer(config);
      onCleanup(() => fixtures.close());
      const { page } = manage(await openPuppeteerSession(config, { profileId: requireProfileId(config), log, signal }));
      await page.goto(fixtures.url('storage.html'));
      const value = String(flags.value ?? 'persisted-by-incogniton-starter-puppeteer');

      if (phase === 'write') {
        await page.setCookie({ name: 'starter_cookie', value, url: fixtures.origin, expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 });
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
        await page.reload();
        await page.screenshot({ path: artifact('written.png') });
        return { summary: `Wrote cookie, localStorage and IndexedDB value "${value}" for ${fixtures.origin}.`, details: { origin: fixtures.origin, value } };
      }

      if (phase === 'reset') {
        await page.deleteCookie({ name: 'starter_cookie', url: fixtures.origin });
        await page.evaluate(async () => {
          localStorage.removeItem('starter_local');
          await new Promise((resolve) => { const r = indexedDB.deleteDatabase('starter_db'); r.onsuccess = r.onerror = r.onblocked = resolve; });
        });
        return { summary: `Removed starter_cookie, starter_local and starter_db for ${fixtures.origin}.` };
      }

      const cookie = (await page.cookies(fixtures.origin)).find((c) => c.name === 'starter_cookie')?.value ?? null;
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
      await page.screenshot({ path: artifact('verified.png') });
      const verified = { cookie: cookie === value, localStorage: local === value, indexedDB: idb === value };
      check(verified.cookie && verified.localStorage && verified.indexedDB, `values after relaunch: cookie=${cookie} localStorage=${local} indexedDB=${idb} (expected "${value}")`);
      return { summary: 'Cookie, localStorage and IndexedDB values survived a full profile stop and relaunch (Puppeteer).', details: { origin: fixtures.origin, verified } };
    },
  );
}
