// Starter application: configuration -> launch + connect -> workflow -> artifacts -> cleanup.
//   npm start                                   run the "example" workflow once
//   npm start -- --workflow <name>              run another registered workflow
//   npm start -- --repeat 5 --interval 300      5 runs, 300 s apart (bounded; Ctrl+C stops cleanly)
// Add your logic in starter/src/workflows/ and register it in workflows/index.ts.
import { StarterError } from '../../lib/errors.js';
import { requireProfileId } from '../../lib/config.js';
import { startFixtureServer } from '../../lib/fixture-server.js';
import { openPlaywrightSession } from '../../lib/playwright-session.js';
import { runExample } from '../../lib/run.js';
import { workflows } from './workflows/index.js';

const options = {
  workflow: { type: 'string', default: 'example' },
  repeat: { type: 'string', default: '1' },
  interval: { type: 'string', default: '60' },
} as const;

// Parse --repeat/--interval up front; runExample validates the rest.
const argv = process.argv.slice(2);
const flagValue = (name: string, fallback: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] ?? fallback : fallback);
const repeat = Number(flagValue('repeat', '1'));
const intervalSeconds = Number(flagValue('interval', '60'));
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 1000 || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
  console.error('--repeat must be an integer 1..1000 and --interval a number of seconds >= 0');
  process.exit(2);
}

let stopRequested = false;
const onSignal = () => {
  stopRequested = true;
};
process.on('SIGINT', onSignal); // the run in progress handles its own cleanup; this stops further runs

for (let iteration = 1; iteration <= repeat && !stopRequested; iteration++) {
  if (repeat > 1) console.log(`\n=== starter run ${iteration}/${repeat} ===`);
  // Runs never overlap: each iteration finishes (including profile shutdown) before the next
  // starts, and the profile lock rejects a second process using the same profile.
  await runExample(
    { id: 'starter', framework: 'playwright', description: 'Run a registered workflow in an Incogniton profile.' },
    options,
    async ({ config, flags, artifact, manage, onCleanup, log, signal }) => {
      const workflow = workflows[String(flags.workflow)];
      if (!workflow) {
        throw new StarterError('config_invalid', `Unknown workflow "${String(flags.workflow)}". Registered: ${Object.keys(workflows).join(', ')}`);
      }
      const fixtures = await startFixtureServer(config);
      onCleanup(() => fixtures.close());
      const profileId = requireProfileId(config);
      const session = manage(await openPlaywrightSession(config, { profileId, log, signal }));
      log(`running workflow "${workflow.name}" in ${session.browserVersion}`);
      const result = await workflow.run({ page: session.page, context: session.context, profileId, config, fixtures, artifact, log, signal });
      return { summary: result.summary, details: { workflow: workflow.name, iteration, ...result.details } };
    },
  );
  if (process.exitCode && process.exitCode !== 0) break; // stop repeating after a failure
  if (iteration < repeat && !stopRequested) {
    console.log(`next run in ${intervalSeconds}s (Ctrl+C to stop)`);
    for (let waited = 0; waited < intervalSeconds * 1000 && !stopRequested; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
process.off('SIGINT', onSignal);
