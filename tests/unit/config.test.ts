import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONFIG_KEYS, flagOverrides, loadConfig, parseEnvFile } from '../../lib/config.js';
import { renderEnvExample, updateEnvFile } from '../../lib/env-file.js';
import { StarterError } from '../../lib/errors.js';

const ID = '7a8ec8d8-6b0b-4e60-86d2-accef152dedd';

test('parseEnvFile handles comments, quotes and inline comments', () => {
  const parsed = parseEnvFile('# c\nA=1\nB="two words"\nC=3 # trailing\n\nBAD LINE\nD=\n');
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: '3', D: '' });
});

test('loadConfig applies defaults and precedence (flags > env)', () => {
  const config = loadConfig(flagOverrides({ 'profile-id': ID, headed: true }), { INCOGNITON_API_PORT: '40000', INCOGNITON_HEADLESS: 'true' });
  assert.equal(config.apiPort, 40000);
  assert.equal(config.profileId, ID);
  assert.equal(config.headless, false);
  assert.equal(config.fixturePort, 47811);
});

test('loadConfig reports every invalid value at once', () => {
  assert.throws(
    () => loadConfig({}, { INCOGNITON_API_PORT: 'abc', INCOGNITON_HEADLESS: 'maybe', INCOGNITON_PROFILE_ID: 'not-a-uuid', FIXTURE_PORT: '47812' }),
    (error: StarterError) => {
      assert.equal(error.kind, 'config_invalid');
      assert.match(error.message, /INCOGNITON_API_PORT/);
      assert.match(error.message, /INCOGNITON_HEADLESS/);
      assert.match(error.message, /INCOGNITON_PROFILE_ID/);
      assert.match(error.message, /must differ/);
      return true;
    },
  );
});

test('loadConfig rejects malformed IDs in INCOGNITON_PROFILE_IDS', () => {
  assert.throws(() => loadConfig({}, { INCOGNITON_PROFILE_IDS: `${ID},nope` }), /nope/);
});

test('.env.example documents every configuration key', () => {
  const example = renderEnvExample();
  for (const key of CONFIG_KEYS) assert.match(example, new RegExp(`^${key.env}=`, 'm'));
  assert.deepEqual(Object.keys(parseEnvFile(example)).sort(), CONFIG_KEYS.map((k) => k.env).sort());
});

test('updateEnvFile changes only selected keys and keeps comments and unknown keys', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'starter-env-')), '.env');
  writeFileSync(path, '# my comment\nINCOGNITON_API_PORT=35000\nMY_OWN_KEY=keep\n');
  const result = updateEnvFile({ INCOGNITON_PROFILE_ID: ID, INCOGNITON_API_PORT: '35000' }, path);
  assert.deepEqual(result.changed, ['INCOGNITON_PROFILE_ID']);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /# my comment/);
  assert.match(text, /MY_OWN_KEY=keep/);
  assert.match(text, new RegExp(`INCOGNITON_PROFILE_ID=${ID}`));
});
