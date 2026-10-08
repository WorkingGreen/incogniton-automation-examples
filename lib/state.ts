/**
 * Local bookkeeping under .incogniton/ (ignored by git):
 * - created-profiles.json: profiles created by this checkout. Cleanup commands
 *   only ever delete IDs listed here, never other profiles.
 * - sessions/<profileId>.json: browsers started by `npm run session -- start`,
 *   with the CDP endpoint needed to attach later.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const STATE_DIR = resolve(process.cwd(), '.incogniton');
const CREATED_FILE = join(STATE_DIR, 'created-profiles.json');
const SESSIONS_DIR = join(STATE_DIR, 'sessions');

export interface CreatedProfileRecord {
  profileId: string;
  name: string;
  createdAt: string;
  createdBy: string;
}

export function readCreatedProfiles(): CreatedProfileRecord[] {
  if (!existsSync(CREATED_FILE)) return [];
  return JSON.parse(readFileSync(CREATED_FILE, 'utf8')) as CreatedProfileRecord[];
}

function writeCreatedProfiles(records: CreatedProfileRecord[]) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CREATED_FILE, `${JSON.stringify(records, null, 2)}\n`);
}

export function recordCreatedProfile(record: CreatedProfileRecord): void {
  writeCreatedProfiles([...readCreatedProfiles().filter((r) => r.profileId !== record.profileId), record]);
}

export function forgetCreatedProfile(profileId: string): void {
  writeCreatedProfiles(readCreatedProfiles().filter((r) => r.profileId !== profileId));
}

export function isCreatedByStarter(profileId: string): boolean {
  return readCreatedProfiles().some((r) => r.profileId === profileId);
}

export interface SessionRecord {
  profileId: string;
  cdpUrl: string;
  browserVersion: string;
  headless: boolean;
  startedAt: string;
}

export function writeSessionRecord(record: SessionRecord): string {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const path = join(SESSIONS_DIR, `${record.profileId}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function readSessionRecord(profileId: string): SessionRecord | undefined {
  const path = join(SESSIONS_DIR, `${profileId}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SessionRecord) : undefined;
}

export function listSessionRecords(): SessionRecord[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf8')) as SessionRecord);
}

export function removeSessionRecord(profileId: string): void {
  rmSync(join(SESSIONS_DIR, `${profileId}.json`), { force: true });
}

/** True when the CDP endpoint of a recorded session still answers. */
export async function isCdpAlive(cdpUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
