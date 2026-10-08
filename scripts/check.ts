// Static checks that need no Incogniton app (used by CI):
// typecheck, unit/contract tests, manifest + referenced paths/commands, generated-doc drift,
// relative links in Markdown, and that no private paths or secrets leaked into tracked text.
//   npm run check
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { readManifest, validateManifest } from '../lib/manifest.js';

let failed = 0;
const step = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const run = (name: string, command: string, args: string[]) => {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  step(name, result.status === 0);
};

run('typecheck', 'npm', ['run', 'typecheck']);
run('unit and contract tests', 'npm', ['test']);
run('generated docs are up to date', 'npm', ['run', 'docs:check']);

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
const problems = validateManifest(readManifest(), pkg.scripts);
step('examples/index.json', problems.length === 0, problems.join('; '));

const exact = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(v));
step('direct npm dependencies pinned exactly', exact.length === 0, exact.map(([n, v]) => `${n}@${v}`).join(', '));
const pyUnpinned = readFileSync('requirements.lock', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && !/^[\w.-]+==[\w.+-]+$/.test(l.trim()));
step('requirements.lock fully pinned', pyUnpinned.length === 0, pyUnpinned.join(', '));

// Markdown: every `npm run X` exists and every relative link resolves.
function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (['node_modules', '.git', 'output', '.venv', '.incogniton', '.scratch'].includes(name)) return [];
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return path.endsWith('.md') ? [path] : [];
  });
}
const linkProblems: string[] = [];
const scriptProblems: string[] = [];
for (const file of markdownFiles('.')) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/npm run ([\w:-]+)/g)) if (!pkg.scripts[match[1]!]) scriptProblems.push(`${file}: npm run ${match[1]}`);
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]!;
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = normalize(join(dirname(file), decodeURIComponent(target.split('#')[0]!)));
    if (!existsSync(path)) linkProblems.push(`${file} -> ${target}`);
  }
}
step('npm scripts referenced in Markdown exist', scriptProblems.length === 0, scriptProblems.join('; '));
step('relative Markdown links resolve', linkProblems.length === 0, linkProblems.join('; '));

// Leak guard: no absolute local paths, private repo names or obvious secrets in tracked text files.
const IGNORED = ['node_modules', '.git', 'output', '.venv', '.incogniton', '.scratch', '.ruff_cache', '__pycache__'];
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (IGNORED.includes(name) || name === '.env') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? allFiles(path) : [path.replaceAll('\\', '/')];
  });
}
// Prefer git's view (tracked + untracked, honouring .gitignore); fall back to a directory walk without git.
const gitList = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
const tracked = gitList.status === 0 && gitList.stdout ? gitList.stdout.split('\n').filter(Boolean) : allFiles('.');
const leakPatterns = [/[A-Z]:\\(?:Users|incogniton)/i, /IncognitonV5|IncognitonAPI_V5|incogniton-api-js-client|incogniton-api-python-client/, /proxy_password"\s*:\s*"[^"*]/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /mcp_live_[0-9a-f]{16,}/];
const leaks: string[] = [];
for (const file of tracked) {
  if (!/\.(ts|py|md|json|txt|yml|yaml|html|example|toml)$/.test(file) || file.endsWith('package-lock.json') || file === 'scripts/check.ts') continue;
  const text = readFileSync(file, 'utf8');
  for (const pattern of leakPatterns) if (pattern.test(text)) leaks.push(`${file} matches ${pattern}`);
}
step('no private paths or secrets in tracked files', leaks.length === 0, leaks.join('; '));

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll static checks passed.');
process.exitCode = failed ? 1 : 0;
