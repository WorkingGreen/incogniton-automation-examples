/** Typed access to and validation of examples/index.json (schema: examples/index.schema.json). */
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_KEYS } from './config.js';

export type Prerequisite = 'api' | 'profile' | 'two-profiles' | 'session' | 'python';

export interface ExampleEntry {
  id: string;
  title: string;
  question: string;
  questions: string[];
  summary: string;
  language: 'typescript' | 'python';
  framework: 'playwright' | 'puppeteer' | 'selenium';
  source: string;
  doc: string;
  command: string;
  selfContained?: boolean;
  /** Known product issue affecting this example (shown in docs, copied into compatibility notes). */
  knownIssue?: string;
  prerequisites: Prerequisite[];
  configKeys: string[];
  expectedResult: string;
  lifecycle: string;
  failures: Array<{ symptom: string; cause: string; fix: string }>;
  related: string[];
  verify: { args: string[]; needs: Prerequisite[] };
}

export interface Manifest {
  schemaVersion: 1;
  repository: string;
  examples: ExampleEntry[];
}

export const MANIFEST_PATH = 'examples/index.json';

export function readManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

const REQUIRED: Array<keyof ExampleEntry> = ['id', 'title', 'question', 'questions', 'summary', 'language', 'framework', 'source', 'doc', 'command', 'prerequisites', 'configKeys', 'expectedResult', 'lifecycle', 'failures', 'related', 'verify'];
const PREREQS = new Set<Prerequisite>(['api', 'profile', 'two-profiles', 'session', 'python']);

/** Returns a list of problems; empty when the manifest is valid and every reference resolves. */
export function validateManifest(manifest: Manifest, scripts: Record<string, string>): string[] {
  const problems: string[] = [];
  if (manifest.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  const ids = new Set<string>();
  const configKeys = new Set(CONFIG_KEYS.map((k) => k.env));
  for (const entry of manifest.examples) {
    const where = `example "${entry.id ?? '?'}"`;
    for (const key of REQUIRED) if (entry[key] === undefined) problems.push(`${where}: missing ${key}`);
    if (ids.has(entry.id)) problems.push(`${where}: duplicate id`);
    ids.add(entry.id);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.id)) problems.push(`${where}: id must be kebab-case`);
    if (!['typescript', 'python'].includes(entry.language)) problems.push(`${where}: bad language`);
    if (!['playwright', 'puppeteer', 'selenium'].includes(entry.framework)) problems.push(`${where}: bad framework`);
    if (!existsSync(entry.source)) problems.push(`${where}: source ${entry.source} does not exist`);
    if (entry.doc !== `docs/examples/${entry.id}.md`) problems.push(`${where}: doc must be docs/examples/${entry.id}.md`);
    for (const p of [...entry.prerequisites, ...entry.verify.needs]) if (!PREREQS.has(p)) problems.push(`${where}: unknown prerequisite ${p}`);
    for (const key of entry.configKeys) if (!configKeys.has(key)) problems.push(`${where}: unknown config key ${key}`);
    // Every npm script mentioned in the command must exist; python commands must point at the source.
    for (const match of entry.command.matchAll(/npm run ([\w:-]+)/g)) {
      if (!scripts[match[1]!]) problems.push(`${where}: command uses missing npm script "${match[1]}"`);
    }
    if (entry.language === 'python' && !entry.command.includes(entry.source)) problems.push(`${where}: python command must run ${entry.source}`);
    if (entry.language === 'typescript') {
      const scriptNames = [...entry.command.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]!);
      if (!scriptNames.some((name) => scripts[name]?.includes(entry.source))) problems.push(`${where}: no npm script in the command runs ${entry.source}`);
    }
  }
  for (const entry of manifest.examples) {
    for (const related of entry.related) if (!ids.has(related)) problems.push(`example "${entry.id}": related id "${related}" does not exist`);
  }
  return problems;
}
