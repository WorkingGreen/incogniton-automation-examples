// Play one round of a canvas game in an Incogniton profile: click START on the canvas,
// steer with arrow-key presses (key down/up), collect all coins, verify completion.
//
// Observation modes (--observe):
//   pixels (default)  screenshot the canvas and locate player/coins by colour. Works on any
//                     canvas whose sprites you can recognise; no page cooperation needed.
//   state             read window.fixtureGame.getState(), an API only this fixture provides.
// In pixels mode the fixture state is still read once per step as an independent cross-check.
//
// This shows how to drive browser input. It is not a general game solver: real games need
// their own observation (sprites, OCR, model) and policy, and must be used within their terms.
// Run: npm run example:game
import type { Page } from 'playwright-core';
import { requireProfileId } from '../../lib/config.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { decodePng, findColorCells, hexToRgb } from '../../lib/png.js';
import { check, runExample } from '../../lib/run.js';

type Cell = { x: number; y: number };
type Observation = { player: Cell | undefined; coins: Cell[] };
const GRID = { cols: 24, rows: 16 }; // the fixture's grid; a real game would need its own layout knowledge
const PLAYER_COLOR = hexToRgb('#2f80ff');
const COIN_COLOR = hexToRgb('#ffc83d');

/** The canvas drawing surface in viewport CSS pixels (border box minus borders) and its pixel size. */
type Surface = { x: number; y: number; width: number; height: number; canvasWidth: number; canvasHeight: number };
async function canvasSurface(page: Page): Promise<Surface> {
  return page.locator('#game').evaluate((el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect(); // includes the CSS border
    return { x: rect.left + el.clientLeft, y: rect.top + el.clientTop, width: el.clientWidth, height: el.clientHeight, canvasWidth: el.width, canvasHeight: el.height };
  });
}

/** Screenshot-based observation: works from pixels only. */
async function observeByPixels(page: Page, surface: Surface): Promise<Observation> {
  // Clip to the drawing surface so the border does not skew the grid.
  const png = await page.screenshot({ clip: { x: surface.x, y: surface.y, width: surface.width, height: surface.height } });
  const image = decodePng(png);
  const player = findColorCells(image, PLAYER_COLOR, GRID)[0];
  const coins = findColorCells(image, COIN_COLOR, GRID).map(({ x, y }) => ({ x, y }));
  return { player, coins };
}

type FixtureState = { phase: string; player: Cell; coins: Cell[]; collected: number; moves: number };

/** Fixture-specific observation (not available on arbitrary websites). */
async function observeByState(page: Page): Promise<FixtureState> {
  return page.evaluate(() => (window as unknown as { fixtureGame: { getState(): FixtureState } }).fixtureGame.getState());
}

/** One discrete move: key down, short hold, key up (the game moves once per press). */
async function tap(page: Page, key: string) {
  await page.keyboard.down(key);
  await page.waitForTimeout(30); // intentional input timing, not a readiness wait
  await page.keyboard.up(key);
}

await runExample(
  { id: 'control-canvas-game', framework: 'playwright', description: 'Play the canvas coin-collector fixture with mouse and keyboard input.' },
  { observe: { type: 'string', default: 'pixels' }, 'max-steps': { type: 'string', default: '80' } },
  async ({ config, flags, artifact, manage, onCleanup, log, signal }) => {
    const mode = String(flags.observe);
    check(mode === 'pixels' || mode === 'state', '--observe must be "pixels" or "state"');
    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());
    const { page } = manage(await openPlaywrightSession(config, { profileId: requireProfileId(config), log, signal }));

    await page.setViewportSize({ width: 900, height: 760 });
    await page.goto(fixtures.url('game.html'));
    const canvas = page.locator('#game');
    await canvas.waitFor();

    // Convert canvas pixel coordinates to page coordinates from the element's real geometry.
    // The canvas is drawn at 480x320 but displayed at a different CSS size, with a border.
    await canvas.scrollIntoViewIfNeeded();
    const surface = await canvasSurface(page);
    const toPage = (cx: number, cy: number) => ({
      x: surface.x + (cx * surface.width) / surface.canvasWidth,
      y: surface.y + (cy * surface.height) / surface.canvasHeight,
    });

    // START button is drawn at canvas (180,140) size 120x40: click its centre.
    const start = toPage(240, 160);
    await page.mouse.click(start.x, start.y); // the click also gives the canvas keyboard focus
    check(await canvas.evaluate((el) => el === document.activeElement), 'canvas did not receive keyboard focus');
    await page.getByRole('status').filter({ hasText: 'Playing' }).waitFor();
    await page.screenshot({ path: artifact('started.png') });

    const maxSteps = Number(flags['max-steps']);
    let steps = 0;
    let mismatches = 0;
    // Observation/action loop: observe, decide, act, repeat.
    for (; steps < maxSteps; steps++) {
      const truth = await observeByState(page);
      if (truth.phase === 'complete') break;
      const seen = mode === 'pixels' ? await observeByPixels(page, surface) : truth;
      if (mode === 'pixels' && (seen.player?.x !== truth.player.x || seen.player?.y !== truth.player.y || seen.coins.length !== truth.coins.length)) {
        mismatches++;
        log(`pixel observation differs from fixture state at step ${steps}`);
      }
      check(seen.player && seen.coins.length > 0, `could not observe player/coins at step ${steps}`);
      // Policy: walk to the nearest coin, horizontal first.
      const target = seen.coins.reduce((best, c) =>
        Math.abs(c.x - seen.player!.x) + Math.abs(c.y - seen.player!.y) < Math.abs(best.x - seen.player!.x) + Math.abs(best.y - seen.player!.y) ? c : best,
      );
      const dx = target.x - seen.player.x;
      const dy = target.y - seen.player.y;
      const key = dx !== 0 ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : dy > 0 ? 'ArrowDown' : 'ArrowUp';
      // Act on up to 4 cells before observing again (fewer screenshots, still closed-loop).
      const presses = Math.min(4, Math.abs(dx !== 0 ? dx : dy));
      for (let i = 0; i < presses; i++) await tap(page, key);
    }

    const final = await observeByState(page);
    await page.getByRole('status').filter({ hasText: 'Round complete' }).waitFor();
    const statusText = await page.getByRole('status').textContent();
    const finalPixels = await observeByPixels(page, surface);
    await page.screenshot({ path: artifact('complete.png') });
    check(final.phase === 'complete' && final.collected === 3, `game not complete: ${JSON.stringify(final)}`);
    check(finalPixels.coins.length === 0, 'coins still visible in the final screenshot');
    check(mismatches === 0, `${mismatches} pixel observations disagreed with the fixture state`);

    return {
      summary: `Round complete (${statusText}) using ${mode} observation in ${steps} observe/act steps.`,
      details: { observe: mode, steps, moves: final.moves, canvasSurface: surface, pixelStateMismatches: mismatches },
    };
  },
);
