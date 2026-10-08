// Serves the fixture pages for manual inspection in any browser.
//   npm run fixtures      then open http://127.0.0.1:47811/ (Ctrl+C to stop)
import { loadConfig } from '../lib/config.js';
import { startFixtureServer } from '../lib/fixture-server.js';

const config = loadConfig();
const fixtures = await startFixtureServer(config);
console.log(`Fixtures: ${fixtures.url('')}  (cross-origin frames: ${fixtures.crossOrigin})`);
for (const page of ['index.html', 'form.html', 'storage.html', `iframe.html?crossPort=${config.fixtureCrossOriginPort}`, 'game.html', 'products.html', 'files.html', 'network.html']) {
  console.log(`  ${fixtures.url(page)}`);
}
console.log('Press Ctrl+C to stop.');
process.on('SIGINT', () => {
  void fixtures.close().then(() => process.exit(0));
});
