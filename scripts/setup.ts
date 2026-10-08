// Creates or updates .env. Interactive in a terminal; non-interactive with flags or without a TTY.
//   npm run setup                                         interactive (prompts)
//   npm run setup -- --profile-id <id> [--port 35000] [--headless true|false]
//   npm run setup -- --create-test-profile                create a dedicated test profile and use it
//   npm run setup -- --non-interactive                    never prompt (CI / coding agents)
// Existing values are kept unless you pass a new value for that key.
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CONFIG_KEYS, isProfileId, loadConfig, readEnvFile } from '../lib/config.js';
import { updateEnvFile } from '../lib/env-file.js';
import { EXIT_CODES, failureKindOf } from '../lib/errors.js';
import { checkAlive, createApi, getProfileStatus } from '../lib/incogniton.js';
import { createRecordedProfile } from '../lib/profiles.js';
import { reportFatal } from '../lib/run.js';

const { values } = parseArgs({
  options: {
    'profile-id': { type: 'string' },
    port: { type: 'string' },
    headless: { type: 'string' },
    'create-test-profile': { type: 'boolean' },
    'non-interactive': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  },
});

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !values['non-interactive'] && !values.yes;

async function main() {
  const existing = readEnvFile();
  const updates: Record<string, string> = {};
  if (values.port) updates.INCOGNITON_API_PORT = values.port;
  if (values.headless) updates.INCOGNITON_HEADLESS = values.headless;
  if (values['profile-id']) {
    if (!isProfileId(values['profile-id'])) throw new Error(`--profile-id "${values['profile-id']}" is not a profile ID (UUID).`);
    updates.INCOGNITON_PROFILE_ID = values['profile-id'];
  }

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (question: string, fallback: string) => {
    if (!rl) return fallback;
    const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
    return answer || fallback;
  };

  try {
    if (interactive && !values.port) {
      updates.INCOGNITON_API_PORT = await ask('Incogniton API port (Settings > Automation in the app)', existing.INCOGNITON_API_PORT || '35000');
    }
    const port = Number(updates.INCOGNITON_API_PORT ?? existing.INCOGNITON_API_PORT ?? 35000);
    const alive = await checkAlive(port);
    console.log(alive.ok ? `Incogniton API reachable on 127.0.0.1:${port}.` : `Incogniton API NOT reachable on 127.0.0.1:${port} (${alive.error ?? alive.body}).`);
    if (!alive.ok) {
      console.log('  Start the Incogniton desktop app, log in, and check Settings > Automation. You can finish setup later.');
    }

    if (values['create-test-profile']) {
      if (!alive.ok) throw new Error('Cannot create a profile while the API is unreachable.');
      const api = createApi(loadConfig({ INCOGNITON_API_PORT: String(port) }));
      const id = await createRecordedProfile(api, { name: `starter-test-${new Date().toISOString().slice(0, 10)}`, createdBy: 'npm run setup -- --create-test-profile' });
      console.log(`Created dedicated test profile ${id} (recorded in .incogniton/created-profiles.json).`);
      updates.INCOGNITON_PROFILE_ID = id;
    } else if (interactive && !values['profile-id']) {
      console.log('Profile to use for the examples. Use a DEDICATED test profile: examples write test cookies/storage to it.');
      console.log('List IDs with: npm run profiles -- list   (or answer "new" to create a test profile now)');
      const answer = await ask('Profile ID', existing.INCOGNITON_PROFILE_ID || '');
      if (answer === 'new' && alive.ok) {
        const api = createApi(loadConfig({ INCOGNITON_API_PORT: String(port) }));
        updates.INCOGNITON_PROFILE_ID = await createRecordedProfile(api, { name: `starter-test-${new Date().toISOString().slice(0, 10)}`, createdBy: 'npm run setup' });
        console.log(`Created ${updates.INCOGNITON_PROFILE_ID}.`);
      } else if (answer) {
        if (!isProfileId(answer)) throw new Error(`"${answer}" is not a profile ID (UUID).`);
        updates.INCOGNITON_PROFILE_ID = answer;
      }
    }
    if (interactive && !values.headless) {
      updates.INCOGNITON_HEADLESS = await ask('Run the profile browser headless? (true/false)', existing.INCOGNITON_HEADLESS || 'true');
    }
  } finally {
    rl?.close();
  }

  const { created, changed } = updateEnvFile(updates);
  console.log(created ? 'Created .env from the defaults in .env.example.' : changed.length ? `Updated .env: ${changed.join(', ')}.` : '.env unchanged.');

  // Validate the result and give the next step.
  const config = loadConfig({}, { ...readEnvFile(), ...process.env });
  const knownKeys = new Set(CONFIG_KEYS.map((k) => k.env));
  const unknown = Object.keys(readEnvFile()).filter((key) => !knownKeys.has(key));
  if (unknown.length) console.log(`Note: .env contains keys this starter does not use: ${unknown.join(', ')}`);
  if (!config.profileId) {
    console.log('\nNo profile configured yet. Next: npm run profiles -- list, then npm run setup -- --profile-id <id>');
    return;
  }
  const alive = await checkAlive(config.apiPort);
  if (alive.ok) {
    const status = await getProfileStatus(createApi(config), config.profileId).catch((error: Error) => `error: ${error.message}`);
    console.log(`Profile ${config.profileId}: ${status}`);
  }
  console.log('\nNext: npm run doctor, then npm run example:screenshot');
}

try {
  await main();
} catch (error) {
  reportFatal('setup', error);
  process.exitCode = EXIT_CODES[failureKindOf(error)] || EXIT_CODES.config_invalid;
}
