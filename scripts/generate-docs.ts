// Generates documentation from examples/index.json and the runnable sources, so pages never
// drift from the code:
//   docs/examples/<id>.md, docs/examples/README.md, the README example table (between markers),
//   llms.txt, llms-full.txt and .env.example.
//   npm run docs:generate          write files
//   npm run docs:check             fail (exit 1) if any generated file is out of date
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_KEYS } from '../lib/config.js';
import { renderEnvExample } from '../lib/env-file.js';
import { readManifest, validateManifest, type ExampleEntry, type Prerequisite } from '../lib/manifest.js';
import { parseCli } from '../lib/cli.js';

const { values } = parseCli(import.meta.url, { check: { type: 'boolean' } });
const manifest = readManifest();
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string>; dependencies: Record<string, string> };
const problems = validateManifest(manifest, pkg.scripts);
if (problems.length > 0) {
  console.error(`examples/index.json is invalid:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

interface CompatibilityResult {
  exampleId: string;
  status: string;
  date: string;
  host: string;
  browser?: string;
}
const compatibility = existsSync('docs/compatibility.json')
  ? (JSON.parse(readFileSync('docs/compatibility.json', 'utf8')) as { liveResults?: CompatibilityResult[]; packages?: Record<string, string> })
  : {};
const liveResult = (id: string) => compatibility.liveResults?.find((r) => r.exampleId === id);

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code.replace(/\n+$/, '')}\n\`\`\``;
const byId = new Map(manifest.examples.map((e) => [e.id, e]));
const pyVersions = Object.fromEntries(
  read('requirements.txt')
    .split('\n')
    .filter((l) => /^[\w-]+==/.test(l))
    .map((l) => l.split('==') as [string, string]),
);

/** Extracts a top-level Python function (decorators/comments excluded) by name. */
function pythonFunction(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^(async )?def ${name}\\(`).test(l));
  if (start < 0) throw new Error(`function ${name} not found`);
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]!))) end++;
  return lines.slice(start, end).join('\n').replace(/\n+$/, '');
}

const PREREQ_TEXT: Record<Prerequisite, string> = {
  api: 'The Incogniton desktop app is installed (Windows or macOS), running, and logged in to an account whose plan includes automation. The local API is enabled (Incogniton app: Settings > Automation; default port 35000).',
  profile: 'A dedicated test profile ID in `.env` (`INCOGNITON_PROFILE_ID`). The profile must be closed (status Ready). The example writes test data only to the local fixture origins (http://127.0.0.1:47811 and :47812).',
  'two-profiles': 'At least two distinct, closed test profiles (`--profile-ids` or `INCOGNITON_PROFILE_IDS`). Create test profiles with `npm run profiles -- create`.',
  session: 'A browser started with `npm run session -- start` (see Install and run).',
  python: 'Python 3.10+ (tested 3.12.7) with the locked dependencies installed in a virtual environment (see Install and run).',
  mcp: 'An MCP token in `.env` as `INCOGNITON_MCP_TOKEN` (Incogniton app: My Account > Settings > MCP Token; treat it like a password, `.env` is git-ignored). If your account has several logged-in desktop sessions, `INCOGNITON_MCP_SESSION_ID` (or `--session-id`) for this machine. The script must run on the machine where the Incogniton app runs. See [Using Incogniton with AI assistants (MCP)](../mcp.md).',
};

function installSteps(entry: ExampleEntry): string {
  const steps: string[] = [
    '```bash\ngit clone https://github.com/WorkingGreen/incogniton-automation-examples.git\n```',
    '```bash\ncd incogniton-automation-examples\n```',
    '```bash\nnpm ci\n```',
    '```bash\nnpm run setup -- --profile-id <your-test-profile-id>\n```',
    '```bash\nnpm run doctor\n```',
  ];
  if (entry.language === 'python') {
    steps.push(
      'Python environment, **Windows** (PowerShell or cmd):',
      '```bash\npython -m venv .venv\n```',
      '```bash\n.venv\\Scripts\\python -m pip install -r requirements.lock\n```',
      fence('bash', entry.command.replace(/^python /, '.venv\\Scripts\\python ')),
      'Python environment, **macOS**:',
      '```bash\npython3 -m venv .venv\n```',
      '```bash\n.venv/bin/python -m pip install -r requirements.lock\n```',
      fence('bash', entry.command.replace(/^python /, '.venv/bin/python ')),
    );
  } else if (entry.prerequisites.includes('session') || entry.verify.needs.includes('session')) {
    steps.push('Start a long-lived browser, attach, then stop it:', '```bash\nnpm run session -- start\n```', fence('bash', entry.command), '```bash\nnpm run session -- stop\n```');
  } else {
    steps.push(fence('bash', entry.command));
  }
  return steps.join('\n\n');
}

function versionsLine(entry: ExampleEntry): string {
  const deps = entry.language === 'python'
    ? `incogniton ${pyVersions.incogniton} (PyPI), ${entry.framework} ${pyVersions[entry.framework] ?? ''}`
    : `incogniton ${pkg.dependencies.incogniton} (npm), ${entry.framework === 'puppeteer' ? `puppeteer-core ${pkg.dependencies['puppeteer-core']}` : `playwright-core ${pkg.dependencies['playwright-core']}`}`;
  const live = liveResult(entry.id);
  const status = live
    ? `${live.status === 'verified' ? 'Verified' : live.status} against a real Incogniton desktop app on ${live.date} (${live.host}${live.browser ? `, ${live.browser}` : ''}).`
    : 'Not yet verified against a live Incogniton app in docs/compatibility.json.';
  return `${status} Dependencies: ${deps}.`;
}

function renderPage(entry: ExampleEntry): string {
  const source = read(entry.source);
  const lang = entry.language === 'python' ? 'python' : 'ts';
  const config = entry.configKeys.map((key) => {
    const info = CONFIG_KEYS.find((k) => k.env === key)!;
    return `| \`${key}\` | \`${info.default || '(empty)'}\` | ${info.description} |`;
  });
  const sections: string[] = [
    `<!-- Generated by scripts/generate-docs.ts from examples/index.json and ${entry.source}. Do not edit by hand. -->`,
    `# ${entry.title}`,
    `Official [Incogniton](https://incogniton.com) automation example (\`${entry.id}\`, ${entry.language === 'python' ? 'Python' : 'TypeScript/Node.js'}, ${entry.framework}). Part of [incogniton-automation-examples](${manifest.repository}).`,
    `**Question:** ${entry.question}${entry.questions.length ? `\nAlso answers: ${entry.questions.map((q) => `"${q}"`).join(', ')}` : ''}`,
    `## Goal\n\n${entry.summary}`,
    `## Support status\n\n${versionsLine(entry)} Supported hosts: Windows and macOS with the Incogniton desktop app; Linux and containers are not supported by the desktop app. See [compatibility](../compatibility.json).${entry.knownIssue ? `

**Known issue:** ${entry.knownIssue}` : ''}`,
    `## Prerequisites\n\n${[...new Set(['api', ...entry.prerequisites] as Prerequisite[])].map((p) => `- ${PREREQ_TEXT[p]}`).join('\n')}\n- Node.js 22.12+ (the setup scripts are Node-based for every language).`,
    `## Install and run\n\n${installSteps(entry)}`,
    `## Configuration\n\nRead from \`.env\` (created by \`npm run setup\`, documented in [.env.example](../../.env.example)); command-line flags \`--profile-id\`, \`--headed\`, \`--headless\`, \`--port\` override it.\n\n| Key | Default | Meaning |\n| --- | --- | --- |\n${config.join('\n')}`,
  ];

  if (entry.selfContained) {
    sections.push(`## Complete code\n\nThis file is self-contained: the official \`incogniton\` SDK, ${entry.framework}, and Node.js built-ins only.\n\n${fence(lang, source)}`);
  } else if (entry.language === 'typescript') {
    sections.push(
      `## How the connection works\n\n\`openPlaywrightSession()\`/\`openPuppeteerSession()\` are repository helpers (in [lib/](../../lib/)), not Incogniton SDK methods. They do exactly what this standalone example does, plus deadlines, retries, locking and diagnostics: check the status is \`Ready\`, call the SDK's \`client.automation.launchPuppeteerCustom(profileId, customArgs)\`, check \`status === 'ok'\`, wait for the CDP endpoint, connect, use the default context \`browser.contexts()[0]\`, and shut down with CDP \`Browser.close\` before waiting for \`Ready\`.\n\n<details><summary>Standalone connection code (examples/playwright/launch-profile-and-screenshot.ts)</summary>\n\n${fence('ts', read('examples/playwright/launch-profile-and-screenshot.ts'))}\n\n</details>`,
      `## Complete example source\n\n${fence(lang, source)}`,
    );
  } else {
    const common = read('examples/python/starter_common.py');
    sections.push(
      `## How the connection works\n\n\`launch_for_cdp()\` and \`shutdown_owned_profile()\` are repository helpers in [examples/python/starter_common.py](../../examples/python/starter_common.py), not SDK methods. They call the SDK's \`client.profile.get_status()\`, \`client.automation.launch_puppeteer_custom()\` and \`client.profile.stop()\`:\n\n${fence('python', `${pythonFunction(common, 'wait_until_ready')}\n\n\n${pythonFunction(common, 'launch_for_cdp')}\n\n\n${pythonFunction(common, 'shutdown_owned_profile')}`)}`,
      `## Complete example source\n\n${fence(lang, source)}`,
    );
  }
  sections.push(
    `## Expected result\n\n${entry.expectedResult}\n\nEvery run writes \`result.json\` (schema: [result-schema.md](../result-schema.md)) and \`summary.txt\` to \`output/<example-id>/<timestamp>/\`. Exit codes: [troubleshooting](../troubleshooting.md#exit-codes).`,
    `## Lifecycle and persistence\n\n${entry.lifecycle}\n\nBackground: [Lifecycle and persistence](../lifecycle-and-persistence.md).`,
    `## Common failures\n\n${entry.failures.length ? `| Symptom | Cause | Fix |\n| --- | --- | --- |\n${entry.failures.map((f) => `| ${f.symptom.replace(/\|/g, '\\|')} | ${f.cause} | ${f.fix} |`).join('\n')}\n\n` : ''}More: [troubleshooting](../troubleshooting.md). Run \`npm run doctor\` first.`,
    `## Related examples\n\n${entry.related.map((id) => `- [${byId.get(id)!.title}](${id}.md)`).join('\n')}`,
    `## Source\n\n[\`${entry.source}\`](../../${entry.source}) · manifest entry \`${entry.id}\` in [examples/index.json](../../examples/index.json)`,
  );
  return `${sections.join('\n\n')}\n`;
}

function exampleTable(): string {
  const rows = manifest.examples.map((e) => {
    const live = liveResult(e.id);
    const status = live ? (live.status === 'verified' ? `verified ${live.date}` : live.status) : 'unverified';
    const statusText = e.knownIssue ? `${status} · [known issue](docs/examples/${e.id}.md#support-status)` : status;
    return `| [${e.question}](docs/examples/${e.id}.md) | ${e.language === 'python' ? 'Python' : 'TypeScript'} · ${e.framework} | \`${e.command}\` | ${statusText} |`;
  });
  return `| Task | Language · framework | Command | Live status |\n| --- | --- | --- | --- |\n${rows.join('\n')}`;
}

function llmsTxt(): string {
  return [
    '# Incogniton automation examples',
    '',
    '> Official, runnable examples for automating the Incogniton antidetect browser with Playwright, Puppeteer (Node.js/TypeScript) and Playwright/Selenium (Python) through the local Incogniton API and the official SDKs (`incogniton` on npm and PyPI).',
    '',
    'Key facts: the Incogniton desktop app must be running and logged in (Windows/macOS); the API listens on 127.0.0.1:35000. Launch with the SDK, connect over CDP, and use the profile\'s default context (`browser.contexts()[0]`) for persistent cookies/storage. Stop with CDP `Browser.close` and wait for status `Ready`; `profile.stop()` terminates the browser process.',
    '',
    '## Start here',
    `- [README and quickstart](${manifest.repository}#readme)`,
    `- [Example manifest (JSON)](${manifest.repository}/blob/main/examples/index.json)`,
    `- [Lifecycle and persistence](${manifest.repository}/blob/main/docs/lifecycle-and-persistence.md)`,
    `- [Troubleshooting and exit codes](${manifest.repository}/blob/main/docs/troubleshooting.md)`,
    `- [Compatibility data](${manifest.repository}/blob/main/docs/compatibility.json)`,
    `- [Unattended execution](${manifest.repository}/blob/main/docs/unattended-execution.md)`,
    `- [AI assistants via MCP (hosted Incogniton MCP server, 19 tools, cdp_url hand-off)](${manifest.repository}/blob/main/docs/mcp.md)`,
    '',
    '## Examples',
    ...manifest.examples.map((e) => `- [${e.title}](${manifest.repository}/blob/main/${e.doc}): ${e.question}`),
    '',
    '## Optional',
    `- [All example pages in one file](${manifest.repository}/blob/main/llms-full.txt)`,
    '',
  ].join('\n');
}

const outputs = new Map<string, string>();
for (const entry of manifest.examples) outputs.set(entry.doc, renderPage(entry));
outputs.set(
  'docs/examples/README.md',
  `<!-- Generated by scripts/generate-docs.ts. Do not edit by hand. -->\n# Incogniton automation examples index\n\nEach page stands alone: prerequisites, exact commands, complete code, expected result and failure guidance.\n\n${exampleTable().replace(/docs\/examples\//g, '')}\n`,
);
outputs.set('llms.txt', llmsTxt());
outputs.set('llms-full.txt', `${llmsTxt()}\n\n${manifest.examples.map((e) => outputs.get(e.doc)).join('\n\n---\n\n')}`);
outputs.set('.env.example', renderEnvExample());
const readme = existsSync('README.md') ? read('README.md') : '';
const START = '<!-- examples:start -->';
const END = '<!-- examples:end -->';
if (readme.includes(START) && readme.includes(END)) {
  outputs.set('README.md', readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), `${START}\n${exampleTable()}\n${END}`));
}

let stale = 0;
for (const [path, content] of outputs) {
  const current = existsSync(path) ? read(path) : undefined;
  if (current === content) continue;
  if (values.check) {
    console.error(`out of date: ${path}`);
    stale++;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
}
if (values.check) {
  if (stale) {
    console.error(`\n${stale} generated file(s) are stale. Run: npm run docs:generate`);
    process.exit(1);
  }
  console.log(`docs are up to date (${outputs.size} generated files checked)`);
}
