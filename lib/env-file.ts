/**
 * Reads and updates .env while preserving comments, ordering and unknown keys.
 * Only keys passed to `updateEnvFile` change.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_KEYS, ENV_FILE } from './config.js';

/** Content of .env.example, generated from CONFIG_KEYS (single source of truth). */
export function renderEnvExample(): string {
  const lines = [
    '# Configuration for incogniton-automation-examples.',
    '# Copy to .env (or run `npm run setup`). Flags such as --profile-id override these values,',
    '# and real environment variables override this file.',
    '',
  ];
  for (const key of CONFIG_KEYS) {
    lines.push(`# ${key.description}`);
    lines.push(`${key.env}=${key.default}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function updateEnvFile(updates: Record<string, string>, path = ENV_FILE): { created: boolean; changed: string[] } {
  const created = !existsSync(path);
  const original = created ? renderEnvExample() : readFileSync(path, 'utf8');
  const lines = original.split(/\r?\n/);
  const changed: string[] = [];
  const remaining = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (!match || !remaining.has(match[1]!)) return line;
    const key = match[1]!;
    const value = remaining.get(key)!;
    remaining.delete(key);
    if (match[2]!.trim() !== value) changed.push(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) {
    next.push(`${key}=${value}`);
    changed.push(key);
  }
  const text = next.join('\n').replace(/\n*$/, '\n');
  if (created || changed.length > 0) writeFileSync(path, text);
  return { created, changed };
}
