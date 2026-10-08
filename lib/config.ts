/**
 * Typed configuration shared by the examples, scripts and starter.
 *
 * Precedence: command-line flag > process environment > .env file > default.
 * Values are validated up front so a bad setting fails before any profile is
 * launched. This is a repository helper, not part of the Incogniton SDK.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StarterError } from './errors.js';

export interface StarterConfig {
  /** Local Incogniton automation API port (Settings > Automation in the app). */
  apiPort: number;
  /** Profile used by single-profile examples. Empty when not configured. */
  profileId: string;
  /** Distinct profile IDs for run-multiple-profiles. */
  profileIds: string[];
  /** Adds `--headless=new` to the profile's browser launch arguments. */
  headless: boolean;
  /** Upper bound for preflight + launch + CDP readiness + connect. */
  launchTimeoutMs: number;
  /** Default Playwright/Puppeteer action and navigation timeout. */
  actionTimeoutMs: number;
  /** Upper bound for graceful shutdown and the app's stop/sync pipeline. */
  stopTimeoutMs: number;
  /** Timeout in seconds for ordinary (non-launch) API requests. */
  apiTimeoutSeconds: number;
  /** Root directory for run artifacts. */
  outputDir: string;
  /** Maximum profiles run-multiple-profiles drives at once. */
  maxConcurrency: number;
  /** Port of the local fixture server (same origin across runs). */
  fixturePort: number;
  /** Second fixture port, used as a separate origin for cross-origin iframes. */
  fixtureCrossOriginPort: number;
  /** MCP token (secret) for the MCP examples; empty when not configured. */
  mcpToken: string;
  /** Desktop session id for MCP launches; empty when not configured. */
  mcpSessionId: string;
  /** Hosted MCP endpoint. */
  mcpUrl: string;
}

export interface ConfigKeyInfo {
  env: string;
  key: keyof StarterConfig;
  default: string;
  description: string;
}

/** Single source of truth for configuration keys; .env.example is generated from it. */
export const CONFIG_KEYS: ConfigKeyInfo[] = [
  { env: 'INCOGNITON_API_PORT', key: 'apiPort', default: '35000', description: 'Port of the local Incogniton automation API (Incogniton app: Settings > Automation). The API only listens on 127.0.0.1.' },
  { env: 'INCOGNITON_PROFILE_ID', key: 'profileId', default: '', description: 'Profile used by the single-profile examples. Find IDs with `npm run profiles -- list`. Use a dedicated test profile.' },
  { env: 'INCOGNITON_PROFILE_IDS', key: 'profileIds', default: '', description: 'Comma-separated, distinct profile IDs for run-multiple-profiles.' },
  { env: 'INCOGNITON_HEADLESS', key: 'headless', default: 'true', description: 'true launches the profile browser with --headless=new; false opens a visible window (easier debugging). The desktop app itself must still be running and logged in.' },
  { env: 'INCOGNITON_LAUNCH_TIMEOUT_MS', key: 'launchTimeoutMs', default: '120000', description: 'Upper bound for waiting until the profile is Ready, launching it, and connecting over CDP. Cloud-synced profiles can take longer on first launch.' },
  { env: 'INCOGNITON_ACTION_TIMEOUT_MS', key: 'actionTimeoutMs', default: '15000', description: 'Default timeout for page actions and navigation.' },
  { env: 'INCOGNITON_STOP_TIMEOUT_MS', key: 'stopTimeoutMs', default: '120000', description: 'Upper bound for graceful browser shutdown plus the app stop/sync pipeline.' },
  { env: 'INCOGNITON_API_TIMEOUT_SECONDS', key: 'apiTimeoutSeconds', default: '30', description: 'Timeout in seconds for ordinary API requests (list, status, create, delete).' },
  { env: 'OUTPUT_DIR', key: 'outputDir', default: 'output', description: 'Directory for run artifacts (screenshots, result.json). Ignored by git.' },
  { env: 'MAX_CONCURRENCY', key: 'maxConcurrency', default: '2', description: 'Maximum profiles run-multiple-profiles drives at once. Practical limits depend on your machine and plan.' },
  { env: 'FIXTURE_PORT', key: 'fixturePort', default: '47811', description: 'Port of the local fixture server. Keep it stable: cookies and localStorage belong to the origin http://127.0.0.1:<port>.' },
  { env: 'FIXTURE_CROSS_ORIGIN_PORT', key: 'fixtureCrossOriginPort', default: '47812', description: 'Second fixture port used as a separate origin for the cross-origin iframe.' },
  { env: 'INCOGNITON_MCP_TOKEN', key: 'mcpToken', default: '', description: 'MCP token for the MCP examples (Incogniton app: My Account > Settings > MCP Token). SECRET: it can drive your profiles. Keep it only in .env, which git ignores.' },
  { env: 'INCOGNITON_MCP_SESSION_ID', key: 'mcpSessionId', default: '', description: 'Desktop session to launch on when your account has several logged-in sessions (the MCP example lists them). Use the id of THIS machine: the Incogniton app log shows "authenticated successfully (session_id=...)".' },
  { env: 'INCOGNITON_MCP_URL', key: 'mcpUrl', default: 'https://v5api.incogniton.com/mcp', description: 'Hosted Incogniton MCP endpoint (JSON-RPC over HTTPS).' },
];

export const ENV_FILE = resolve(process.cwd(), '.env');

/** Parses KEY=VALUE lines. Supports comments, blank lines and quoted values. */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    result[key] = value;
  }
  return result;
}

export function readEnvFile(path = ENV_FILE): Record<string, string> {
  return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
}

const PROFILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProfileId(value: string): boolean {
  return PROFILE_ID_RE.test(value);
}

/**
 * Builds and validates the configuration.
 * @param overrides values from command-line flags (env-style keys)
 * @param env defaults to process.env merged over the .env file
 */
export function loadConfig(
  overrides: Record<string, string | undefined> = {},
  env: Record<string, string | undefined> = { ...readEnvFile(), ...process.env },
): StarterConfig {
  const raw = (name: string, fallback: string) => {
    const value = overrides[name] ?? env[name];
    return value === undefined || value === '' ? fallback : value.trim();
  };
  const problems: string[] = [];
  const int = (name: string, fallback: string, min: number, max: number) => {
    const text = raw(name, fallback);
    const value = Number(text);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name}="${text}" must be an integer between ${min} and ${max}.`);
      return Number(fallback);
    }
    return value;
  };
  const bool = (name: string, fallback: string) => {
    const text = raw(name, fallback).toLowerCase();
    if (['true', '1', 'yes'].includes(text)) return true;
    if (['false', '0', 'no'].includes(text)) return false;
    problems.push(`${name}="${text}" must be true or false.`);
    return fallback === 'true';
  };

  const profileId = raw('INCOGNITON_PROFILE_ID', '');
  if (profileId && !isProfileId(profileId)) {
    problems.push(`INCOGNITON_PROFILE_ID="${profileId}" is not a profile ID (expected a UUID such as 7a8ec8d8-6b0b-4e60-86d2-accef152dedd).`);
  }
  const profileIds = raw('INCOGNITON_PROFILE_IDS', '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of profileIds) {
    if (!isProfileId(id)) problems.push(`INCOGNITON_PROFILE_IDS contains "${id}", which is not a profile ID.`);
  }

  const config: StarterConfig = {
    apiPort: int('INCOGNITON_API_PORT', '35000', 1, 65535),
    profileId,
    profileIds,
    headless: bool('INCOGNITON_HEADLESS', 'true'),
    launchTimeoutMs: int('INCOGNITON_LAUNCH_TIMEOUT_MS', '120000', 5000, 3_600_000),
    actionTimeoutMs: int('INCOGNITON_ACTION_TIMEOUT_MS', '15000', 1000, 600_000),
    stopTimeoutMs: int('INCOGNITON_STOP_TIMEOUT_MS', '120000', 5000, 3_600_000),
    apiTimeoutSeconds: int('INCOGNITON_API_TIMEOUT_SECONDS', '30', 1, 600),
    outputDir: raw('OUTPUT_DIR', 'output'),
    maxConcurrency: int('MAX_CONCURRENCY', '2', 1, 32),
    fixturePort: int('FIXTURE_PORT', '47811', 1024, 65535),
    fixtureCrossOriginPort: int('FIXTURE_CROSS_ORIGIN_PORT', '47812', 1024, 65535),
    mcpToken: raw('INCOGNITON_MCP_TOKEN', ''),
    mcpSessionId: raw('INCOGNITON_MCP_SESSION_ID', ''),
    mcpUrl: raw('INCOGNITON_MCP_URL', 'https://v5api.incogniton.com/mcp'),
  };
  if (config.mcpToken && !/^mcp_[A-Za-z0-9_]+$/.test(config.mcpToken)) {
    problems.push('INCOGNITON_MCP_TOKEN does not look like an MCP token (expected mcp_live_...).');
  }
  if (config.mcpSessionId && !/^\d+$/.test(config.mcpSessionId)) {
    problems.push(`INCOGNITON_MCP_SESSION_ID="${config.mcpSessionId}" must be a numeric session id.`);
  }
  if (!/^https:\/\//.test(config.mcpUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.mcpUrl)) {
    problems.push('INCOGNITON_MCP_URL must be https:// (or http:// on localhost for local testing).');
  }
  if (config.fixturePort === config.fixtureCrossOriginPort) {
    problems.push('FIXTURE_PORT and FIXTURE_CROSS_ORIGIN_PORT must differ.');
  }
  if (problems.length > 0) {
    throw new StarterError('config_invalid', `Invalid configuration:\n  - ${problems.join('\n  - ')}`, {
      hint: 'Fix .env (see .env.example) or run `npm run setup`.',
    });
  }
  return config;
}

/** Throws a config error when the single-profile examples have no profile. */
export function requireProfileId(config: StarterConfig): string {
  if (!config.profileId) {
    throw new StarterError('config_invalid', 'No profile configured: INCOGNITON_PROFILE_ID is empty.', {
      hint: 'Run `npm run profiles -- list`, then `npm run setup -- --profile-id <id>` (or pass --profile-id <id>).',
    });
  }
  return config.profileId;
}

/** Common command-line flags accepted by every example, mapped to env keys. */
export function flagOverrides(values: { 'profile-id'?: string; headed?: boolean; headless?: boolean; port?: string }): Record<string, string | undefined> {
  return {
    INCOGNITON_PROFILE_ID: values['profile-id'],
    INCOGNITON_API_PORT: values.port,
    INCOGNITON_HEADLESS: values.headed ? 'false' : values.headless ? 'true' : undefined,
  };
}
