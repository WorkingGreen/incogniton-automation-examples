// Upload a local file through a file input and download a file via a link, in an
// Incogniton profile, then verify both.
// Run: npm run example:files
import { readFileSync, writeFileSync } from 'node:fs';
import { requireProfileId } from '../../lib/config.js';
import { REPORT_CSV, startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { check, runExample } from '../../lib/run.js';

await runExample(
  { id: 'upload-and-download-files', framework: 'playwright', description: 'Upload a file and download a file in an Incogniton profile.' },
  {},
  async ({ config, artifact, manage, onCleanup, log, signal }) => {
    const fixtures = await startFixtureServer(config);
    onCleanup(() => fixtures.close());
    const { page } = manage(await openPlaywrightSession(config, { profileId: requireProfileId(config), log, signal }));
    await page.goto(fixtures.url('files.html'));

    // Upload: setInputFiles works without a native file dialog.
    const uploadPath = artifact('upload.txt');
    const uploadContent = 'first line\nsecond line\nthird line\n';
    writeFileSync(uploadPath, uploadContent);
    await page.getByLabel('Choose a text file').setInputFiles(uploadPath);
    const uploadResult = page.getByRole('status');
    await uploadResult.filter({ hasText: 'Uploaded upload.txt' }).waitFor();
    const uploadText = await uploadResult.textContent();
    const expectedUpload = `Uploaded upload.txt: ${Buffer.byteLength(uploadContent)} bytes, 3 lines`;
    check(uploadText === expectedUpload, `upload result was "${uploadText}", expected "${expectedUpload}"`);

    // Download: start waiting for the event before clicking, then save to the run directory.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download report.csv' }).click()]);
    const downloadPath = artifact(download.suggestedFilename());
    await download.saveAs(downloadPath);
    const content = readFileSync(downloadPath, 'utf8');
    check(content === REPORT_CSV, 'downloaded report.csv content differs from the served file');

    return {
      summary: `Uploaded upload.txt (verified by the page) and downloaded ${download.suggestedFilename()} (${content.length} bytes, content verified).`,
      details: { uploadText, downloadedFile: download.suggestedFilename(), downloadedBytes: content.length },
    };
  },
);
