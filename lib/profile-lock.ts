/**
 * Host-local profile locks.
 *
 * Prevents two processes started from this checkout from launching the same
 * profile at the same time. Scope and limits:
 * - Only processes that use these helpers on the same machine and checkout
 *   see the lock. It is NOT a distributed lock and does not stop someone
 *   from opening the profile in the Incogniton app.
 * - A lock whose owning process no longer exists is stale and is replaced.
 */
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StarterError } from './errors.js';

const LOCK_DIR = resolve(process.cwd(), '.incogniton', 'locks');
const heldInProcess = new Set<string>();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProfileLock {
  release(): void;
}

export function acquireProfileLock(profileId: string, purpose: string): ProfileLock {
  if (heldInProcess.has(profileId)) {
    throw new StarterError('profile_busy', `Profile ${profileId} is already in use by another job in this process.`);
  }
  mkdirSync(LOCK_DIR, { recursive: true });
  const path = join(LOCK_DIR, `${profileId}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, purpose, since: new Date().toISOString() }));
      closeSync(fd);
      heldInProcess.add(profileId);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          heldInProcess.delete(profileId);
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number; purpose?: string; since?: string } = {};
      try {
        owner = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        // Unreadable lock file: treat as stale.
      }
      if (owner.pid && owner.pid !== process.pid && isProcessAlive(owner.pid)) {
        throw new StarterError('profile_busy', `Profile ${profileId} is locked by process ${owner.pid} (${owner.purpose ?? 'unknown'}, since ${owner.since ?? '?'}).`, {
          hint: `Wait for that run to finish. If no such run exists, delete ${path}.`,
        });
      }
      rmSync(path, { force: true }); // stale: the owner exited without releasing
    }
  }
  throw new StarterError('profile_busy', `Could not acquire the lock for profile ${profileId}.`);
}
