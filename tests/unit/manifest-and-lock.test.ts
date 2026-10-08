import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { acquireProfileLock } from '../../lib/profile-lock.js';
import { readManifest, validateManifest } from '../../lib/manifest.js';
import type { StarterError } from '../../lib/errors.js';

const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;

test('examples/index.json is valid and every path, script and related id resolves', () => {
  assert.deepEqual(validateManifest(readManifest(), scripts), []);
});

test('manifest validation catches a missing npm script and a dangling related id', () => {
  const manifest = readManifest();
  const broken = structuredClone(manifest);
  broken.examples[0]!.command = 'npm run example:does-not-exist';
  broken.examples[0]!.related = ['no-such-example'];
  const problems = validateManifest(broken, scripts);
  assert.ok(problems.some((p) => p.includes('missing npm script "example:does-not-exist"')));
  assert.ok(problems.some((p) => p.includes('related id "no-such-example"')));
});

test('every npm script referenced in README and docs exists', () => {
  const files = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/troubleshooting.md', 'docs/lifecycle-and-persistence.md', 'docs/unattended-execution.md'];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // checked by scripts/check.ts once the file exists
    }
    for (const match of text.matchAll(/npm run ([\w:-]+)/g)) assert.ok(scripts[match[1]!], `${file} references missing script "${match[1]}"`);
  }
});

test('profile lock rejects a second holder in the same process and replaces stale locks', () => {
  const id = '00000000-0000-4000-8000-00000000abcd';
  const lock = acquireProfileLock(id, 'test');
  assert.throws(() => acquireProfileLock(id, 'test'), (error: StarterError) => error.kind === 'profile_busy');
  lock.release();
  lock.release(); // idempotent

  // A lock left by a process that no longer exists is stale and replaced.
  const dir = resolve('.incogniton', 'locks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.lock`), JSON.stringify({ pid: 2147483646, purpose: 'crashed run' }));
  const again = acquireProfileLock(id, 'test');
  again.release();
});
