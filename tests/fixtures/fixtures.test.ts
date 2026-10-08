/**
 * Fixture behaviour tests in a CONVENTIONAL browser (Playwright's Chromium, or a system
 * browser via FIXTURE_BROWSER_CHANNEL=msedge|chrome). They prove the fixtures are
 * deterministic and the observation helpers work. They are NOT Incogniton evidence.
 * Run: npm run test:fixtures   (CI installs Chromium with: npx playwright install chromium)
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { fixtureProducts, startFixtureServer, type FixtureServer } from '../../lib/fixture-server.js';
import { decodePng, findColorCells, hexToRgb } from '../../lib/png.js';

const ports = { fixturePort: 47911, fixtureCrossOriginPort: 47912 }; // separate from the examples' ports
let fixtures: FixtureServer;
let browser: Browser;

before(async () => {
  fixtures = await startFixtureServer(ports);
  browser = await chromium.launch({ channel: process.env.FIXTURE_BROWSER_CHANNEL || undefined, headless: true });
});
after(async () => {
  await browser?.close();
  await fixtures?.close();
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 900, height: 760 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  return page;
}

test('index fixture becomes ready after its delay', async () => {
  const page = await newPage();
  await page.goto(fixtures.url('index.html'));
  assert.equal(await page.locator('#app').getAttribute('data-ready'), 'false');
  await page.getByRole('status').filter({ hasText: 'Fixture ready' }).waitFor();
  assert.equal(await page.locator('#app').getAttribute('data-ready'), 'true');
});

test('form fixture validates and confirms asynchronously', async () => {
  const page = await newPage();
  await page.goto(fixtures.url('form.html'));
  await page.getByRole('button', { name: 'Submit' }).click();
  assert.equal(await page.getByRole('status').textContent(), 'Error: name, plan and terms are required');
  await page.getByLabel('Full name').fill('Ada');
  await page.getByLabel('Plan').selectOption({ label: 'Team' });
  await page.getByLabel('I accept the fixture terms').check();
  await page.getByRole('button', { name: 'Submit' }).click();
  assert.equal(await page.getByRole('status').textContent(), 'Submitting…');
  await page.getByRole('status').filter({ hasText: 'Submitted: Ada (Team plan)' }).waitFor();
});

test('iframe fixture: delayed same-origin and cross-origin frames, postMessage to parent', async () => {
  const page = await newPage();
  await page.goto(fixtures.url(`iframe.html?crossPort=${ports.fixtureCrossOriginPort}`));
  assert.equal(await page.locator('iframe').count(), 0, 'frames are inserted after a delay');
  await page.frameLocator('iframe[title="Counter frame"]').getByRole('button', { name: 'Increment' }).click();
  await page.frameLocator('iframe[title="Counter frame"]').getByText('Count: 1').waitFor();
  const message = page.frameLocator('iframe[title="Message frame"]');
  await message.getByLabel('Message').fill('hi');
  await message.getByRole('button', { name: 'Send to parent' }).click();
  await page.locator('#parent-status').filter({ hasText: 'Parent received: hi' }).waitFor();
  assert.ok(page.frames().some((f) => f.url().startsWith(fixtures.crossOrigin)), 'message frame is cross-origin');
});

test('canvas game: scaled START click, one cell per key press, pixel observation matches state', async () => {
  const page = await newPage();
  await page.goto(fixtures.url('game.html'));
  const canvas = page.locator('#game');
  // Drawing surface in viewport CSS px: border box minus the 1px border.
  const surface = await canvas.evaluate((el: HTMLCanvasElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + el.clientLeft, y: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
  });
  assert.equal(surface.width, 720, 'canvas is displayed scaled (CSS 720px for 480 canvas px)');
  // Keys before START (and without focus) do nothing.
  await page.keyboard.press('ArrowRight');
  const state = () => page.evaluate(() => (window as unknown as { fixtureGame: { getState(): { phase: string; player: { x: number; y: number }; moves: number } } }).fixtureGame.getState());
  assert.equal((await state()).phase, 'idle');
  // A click outside the START button does not start the game.
  await page.mouse.click(surface.x + 10, surface.y + 10);
  assert.equal((await state()).phase, 'idle');
  await page.mouse.click(surface.x + (240 * surface.width) / 480, surface.y + (160 * surface.height) / 320);
  assert.equal((await state()).phase, 'playing');
  // Holding a key (auto-repeat) still moves exactly one cell.
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(600);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const s = await state();
  assert.deepEqual(s.player, { x: 3, y: 3 });
  assert.equal(s.moves, 2);
  const image = decodePng(await page.screenshot({ clip: surface }));
  const player = findColorCells(image, hexToRgb('#2f80ff'), { cols: 24, rows: 16 });
  const coins = findColorCells(image, hexToRgb('#ffc83d'), { cols: 24, rows: 16 });
  assert.deepEqual(player.map(({ x, y }) => ({ x, y })), [{ x: 3, y: 3 }]);
  assert.deepEqual(coins.map(({ x, y }) => ({ x, y })).sort((a, b) => a.x - b.x), [{ x: 9, y: 4 }, { x: 16, y: 12 }, { x: 21, y: 5 }]);
});

test('products API paginates deterministically', async () => {
  const page = await newPage();
  await page.goto(fixtures.url('products.html'));
  await page.getByRole('status').filter({ hasText: 'Page 1 of 3' }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 10);
  assert.ok(await page.getByRole('button', { name: 'Previous' }).isDisabled());
  assert.equal(fixtureProducts().length, 25);
});

test('network fixture loads quote and pixel without interception', async () => {
  const page = await newPage();
  await page.goto(fixtures.url('network.html'));
  await page.getByRole('status').filter({ hasText: 'Quote: Served by the fixture server (source: network)' }).waitFor();
  await page.locator('#pixel-status').filter({ hasText: 'Pixel loaded' }).waitFor();
});

test('fixture server refuses path traversal and identifies itself', async () => {
  const traversal = await fetch(`${fixtures.origin}/..%2fpackage.json`);
  assert.ok([403, 404].includes(traversal.status));
  const id = (await (await fetch(`${fixtures.origin}/__fixture`)).json()) as { name: string };
  assert.equal(id.name, 'incogniton-automation-fixtures');
});

test('a second startFixtureServer on the same ports reuses the running server', async () => {
  const again = await startFixtureServer(ports);
  assert.equal(again.origin, fixtures.origin);
  await again.close(); // closes nothing it did not start
  assert.equal((await fetch(`${fixtures.origin}/__fixture`)).status, 200);
});
