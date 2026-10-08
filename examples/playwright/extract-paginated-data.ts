// Extract a paginated table to JSON in an Incogniton profile: read each page, click Next,
// wait for the new page to render, stop when Next is disabled, validate the result.
// Run: npm run example:extract
import { writeFileSync } from 'node:fs';
import { requireProfileId } from '../../lib/config.js';
import { fixtureProducts, startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { check, runExample } from '../../lib/run.js';

await runExample(
  { id: 'extract-paginated-data', framework: 'playwright', description: 'Extract all rows of a paginated table to JSON.' },
  { 'max-pages': { type: 'string', default: '20' } },
  async ({ config, flags, artifact, manage, onCleanup, log, signal }) => {
    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());
    const { page } = manage(await openPlaywrightSession(config, { profileId: requireProfileId(config), log, signal }));

    await page.goto(fixtures.url('products.html'));
    const pageLabel = page.getByRole('status');
    const next = page.getByRole('button', { name: 'Next' });
    const rows: Array<{ sku: string; name: string; price: number }> = [];

    for (let pageNumber = 1; pageNumber <= Number(flags['max-pages']); pageNumber++) {
      // Wait for the page we expect, not just "some rows": avoids reading stale data after Next.
      await pageLabel.filter({ hasText: new RegExp(`^Page ${pageNumber} of \\d+$`) }).waitFor();
      const pageRows = await page.locator('tbody#rows tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll('td'), (td) => td.textContent?.trim() ?? '')),
      );
      for (const [sku, name, price] of pageRows) rows.push({ sku: sku!, name: name!, price: Number(price) });
      log(`page ${pageNumber}: ${pageRows.length} rows`);
      if (await next.isDisabled()) break;
      await next.click();
    }

    // Validate: count, uniqueness and values against the fixture's known data.
    const expected = fixtureProducts();
    check(rows.length === expected.length, `extracted ${rows.length} rows, expected ${expected.length}`);
    check(new Set(rows.map((r) => r.sku)).size === rows.length, 'duplicate SKUs extracted');
    check(JSON.stringify(rows) === JSON.stringify(expected), 'extracted data differs from the fixture data');
    const output = artifact('products.json');
    writeFileSync(output, `${JSON.stringify(rows, null, 2)}\n`);
    return { summary: `Extracted ${rows.length} products from ${Math.ceil(rows.length / 10)} pages to products.json.`, details: { rows: rows.length } };
  },
);
