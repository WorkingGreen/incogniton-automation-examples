/**
 * Argument parsing for the scripts. Usage text is the script's leading `//` comment block,
 * so it cannot drift from the documented commands. `--help` prints it; unknown flags print
 * it and exit with code 2 (config_invalid) instead of a stack trace.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { EXIT_CODES } from './errors.js';

function usageFromHeader(moduleUrl: string): string {
  const lines = readFileSync(fileURLToPath(moduleUrl), 'utf8').split(/\r?\n/);
  const header: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('//')) break;
    header.push(line.replace(/^\/\/ ?/, ''));
  }
  return header.join('\n');
}

export function parseCli<const O extends NonNullable<ParseArgsConfig['options']>>(moduleUrl: string, options: O, allowPositionals = false) {
  const usage = usageFromHeader(moduleUrl);
  try {
    const parsed = parseArgs({ options: { ...options, help: { type: 'boolean', short: 'h' } } as O & { help: { type: 'boolean'; short: 'h' } }, allowPositionals });
    if ((parsed.values as { help?: boolean }).help) {
      console.log(usage);
      process.exit(0);
    }
    return parsed;
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage}`);
    process.exit(EXIT_CODES.config_invalid);
  }
}
