/**
 * Runner shared by the examples (a repository helper, not part of the SDK).
 *
 * Gives every run:
 * - a unique artifact directory: output/<example-id>/<timestamp>-<random>/
 * - result.json (schema: docs/result-schema.md) and summary.txt
 * - SIGINT/SIGTERM handling that cancels the run and still cleans up
 * - failure screenshots and captured console/page errors for managed pages
 * - cleanup that runs even when the workflow fails, reported separately
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { flagOverrides, loadConfig, type StarterConfig } from './config.js';
import { EXIT_CODES, StarterError, failureKindOf, sanitize, type FailureKind } from './errors.js';
import type { CleanupReport, Log } from './incogniton.js';

/** Minimal page shape shared by Playwright and Puppeteer pages. */
interface ObservablePage {
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  on(event: 'console', listener: (message: { type(): string; text(): string }) => void): unknown;
  on(event: 'pageerror', listener: (error: Error) => void): unknown;
}

export interface ManagedSession {
  profileId: string;
  browserVersion?: string;
  page?: unknown;
  close(): Promise<CleanupReport>;
}

export interface RunContext<Flags> {
  config: StarterConfig;
  flags: Flags;
  runDir: string;
  signal: AbortSignal;
  log: Log;
  /** Absolute path for an artifact inside this run's directory; records it in result.json. */
  artifact(name: string): string;
  /**
   * Registers a session for cleanup (always runs, also on failure/cancel) and
   * for failure diagnostics. Returns the same session for convenience.
   */
  manage<T extends ManagedSession>(session: T, label?: string): T;
  /** Registers an additional cleanup step (e.g. stopping a fixture server). */
  onCleanup(step: () => Promise<unknown>): void;
}

export interface RunOutcome {
  /** One-line human summary printed on success. */
  summary: string;
  /** Example-specific, non-sensitive facts recorded in result.json. */
  details?: Record<string, unknown>;
}

export interface ExampleMeta {
  id: string;
  framework: 'playwright' | 'puppeteer' | 'none';
  description: string;
}

const COMMON_OPTIONS = {
  'profile-id': { type: 'string' },
  headed: { type: 'boolean' },
  headless: { type: 'boolean' },
  port: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

function packageVersion(name: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(resolve('node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return undefined;
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

/**
 * Runs an example body with configuration, artifacts, cancellation and cleanup.
 * Sets process.exitCode according to docs/troubleshooting.md#exit-codes.
 */
export async function runExample<const Extra extends NonNullable<ParseArgsConfig['options']>>(
  meta: ExampleMeta,
  extraOptions: Extra,
  body: (ctx: RunContext<Record<string, string | boolean | undefined>>) => Promise<RunOutcome>,
): Promise<void> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  let flags: Record<string, string | boolean | undefined>;
  try {
    flags = parseArgs({ options: { ...COMMON_OPTIONS, ...extraOptions }, allowPositionals: false }).values as typeof flags;
  } catch (error) {
    console.error(`${meta.id}: ${(error as Error).message}`);
    process.exitCode = EXIT_CODES.config_invalid;
    return;
  }
  if (flags.help) {
    const extra = Object.keys(extraOptions).map((name) => `--${name}`).join(' ');
    console.log(`${meta.id}: ${meta.description}\n\nOptions: --profile-id <id> --headed --headless --port <api port> ${extra}\nConfiguration is read from .env (see .env.example).`);
    return;
  }

  let config: StarterConfig;
  try {
    config = loadConfig(flagOverrides(flags as Parameters<typeof flagOverrides>[0]));
  } catch (error) {
    reportFatal(meta.id, error);
    process.exitCode = EXIT_CODES.config_invalid;
    return;
  }

  const runDir = resolve(config.outputDir, meta.id, `${timestamp()}-${Math.random().toString(16).slice(2, 6)}`);
  mkdirSync(runDir, { recursive: true });
  const artifacts = new Set<string>();
  const sessions: Array<{ label: string; session: ManagedSession }> = [];
  const extraCleanup: Array<() => Promise<unknown>> = [];
  const consoleErrors: string[] = [];
  const log: Log = (message) => console.log(`[${meta.id}] ${message}`);

  const controller = new AbortController();
  let signalCount = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signalCount += 1;
    if (signalCount > 1) {
      console.error(`[${meta.id}] second ${signal}: exiting without waiting for cleanup`);
      process.exit(EXIT_CODES.cancelled);
    }
    console.error(`[${meta.id}] ${signal} received: cancelling and cleaning up (press again to force exit)`);
    controller.abort(new StarterError('cancelled', `Cancelled by ${signal}`));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const ctx: RunContext<typeof flags> = {
    config,
    flags,
    runDir,
    signal: controller.signal,
    log,
    artifact(name) {
      const path = join(runDir, name);
      artifacts.add(path);
      return path;
    },
    manage(session, label = session.profileId) {
      sessions.push({ label, session });
      const page = session.page as ObservablePage | undefined;
      page?.on('console', (message) => {
        if (message.type() === 'error' && consoleErrors.length < 50) consoleErrors.push(sanitize(`[${label}] console: ${message.text()}`, 300));
      });
      page?.on('pageerror', (error) => {
        if (consoleErrors.length < 50) consoleErrors.push(sanitize(`[${label}] pageerror: ${error.message}`, 300));
      });
      return session;
    },
    onCleanup(step) {
      extraCleanup.push(step);
    },
  };

  let outcome: RunOutcome | undefined;
  let failure: unknown;
  const bodyPromise = body(ctx);
  bodyPromise.catch(() => undefined);
  try {
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    cancelled.catch(() => undefined);
    outcome = await Promise.race([bodyPromise, cancelled]);
  } catch (error) {
    failure = error;
    // Failure evidence before cleanup closes the pages.
    for (const { label, session } of sessions) {
      const page = session.page as ObservablePage | undefined;
      if (!page) continue;
      const path = ctx.artifact(`failure-${label.slice(0, 8)}.png`);
      await page.screenshot({ path, fullPage: true }).catch(() => artifacts.delete(path));
    }
  }

  const cleanup: CleanupReport[] = [];
  const closed = new Set<ManagedSession>();
  const closeRegistered = async () => {
    for (const { session } of [...sessions].reverse()) {
      if (closed.has(session)) continue;
      closed.add(session);
      try {
        cleanup.push(await session.close());
      } catch (error) {
        cleanup.push({ profileId: session.profileId, method: 'none', ok: false, sawSyncStatus: false, durationMs: 0, warnings: [], error: sanitize((error as Error).message) });
      }
    }
  };
  await closeRegistered();
  if (controller.signal.aborted) {
    // A launch may still have been in flight when the signal arrived. Let the
    // body settle (bounded), then stop any session it registered afterwards.
    await Promise.race([bodyPromise.catch(() => undefined), new Promise((r) => setTimeout(r, config.launchTimeoutMs))]);
    await closeRegistered();
  }
  for (const step of extraCleanup.reverse()) {
    try {
      await step();
    } catch (error) {
      // A failing cleanup step (e.g. a profile that could not be deleted) fails the cleanup status.
      cleanup.push({ profileId: '-', method: 'none', ok: false, sawSyncStatus: false, durationMs: 0, warnings: [], error: sanitize((error as Error).message) });
    }
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  const cleanupFailed = cleanup.some((report) => !report.ok);
  let kind: FailureKind | 'ok' = 'ok';
  if (failure !== undefined) kind = failureKindOf(failure);
  else if (cleanupFailed) kind = 'cleanup_failed';
  if (kind === 'unknown' && failure instanceof Error && /Timeout \d+ms exceeded|timed out/i.test(failure.message)) kind = 'timeout';
  if (kind === 'unknown' && failure instanceof Error && /expect|assert/i.test(failure.name + failure.message)) kind = 'workflow_failed';

  const browserVersions = [...new Set(sessions.map(({ session }) => session.browserVersion).filter(Boolean))];
  const result = {
    schemaVersion: 1,
    exampleId: meta.id,
    language: 'typescript',
    framework: meta.framework,
    status: failure === undefined ? (cleanupFailed ? 'passed_with_cleanup_failure' : 'passed') : kind === 'cancelled' ? 'cancelled' : 'failed',
    exitCode: EXIT_CODES[kind],
    startedAt,
    durationMs: Date.now() - started,
    summary: outcome?.summary,
    failure:
      failure === undefined
        ? undefined
        : {
            kind,
            message: sanitize(failure instanceof Error ? failure.message : String(failure), 1000),
            hint: failure instanceof StarterError ? failure.hint : undefined,
          },
    details: outcome?.details,
    profiles: sessions.map(({ label, session }) => ({ label, profileId: session.profileId })),
    cleanup,
    consoleErrors,
    artifacts: [...artifacts].map((path) => relative(process.cwd(), path).replaceAll('\\', '/')),
    versions: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      incognitonSdk: packageVersion('incogniton'),
      playwrightCore: meta.framework === 'playwright' ? packageVersion('playwright-core') : undefined,
      puppeteerCore: meta.framework === 'puppeteer' ? packageVersion('puppeteer-core') : undefined,
      browsers: browserVersions,
    },
    config: { apiPort: config.apiPort, headless: config.headless },
  };
  const resultPath = join(runDir, 'result.json');
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  const summaryLines = [
    `${meta.id}: ${result.status.toUpperCase()} in ${(result.durationMs / 1000).toFixed(1)}s`,
    outcome?.summary ?? '',
    result.failure ? `failure (${result.failure.kind}): ${result.failure.message}` : '',
    result.failure?.hint ? `hint: ${result.failure.hint}` : '',
    ...cleanup.map((report) => `cleanup ${report.profileId}: ${report.ok ? 'ok' : 'FAILED'} via ${report.method}${report.finalStatus ? `, final status ${report.finalStatus}` : ''}${report.error ? ` (${report.error})` : ''}`),
    ...cleanup.flatMap((report) => report.warnings.map((warning) => `warning: ${warning}`)),
    ...result.artifacts.map((path) => `artifact: ${path}`),
  ].filter(Boolean);
  writeFileSync(join(runDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
  console.log(`\n${summaryLines.join('\n')}\nresult: ${relative(process.cwd(), resultPath).replaceAll('\\', '/')}`);
  // One stable, machine-readable line for scripts and coding agents.
  const cleanupState = cleanup.length === 0 ? 'none' : cleanup.every((c) => c.ok) ? 'ok' : 'failed';
  console.log(`RESULT status=${result.status} exit=${result.exitCode} cleanup=${cleanupState} json=${resultPath}`);
  process.exitCode = result.exitCode;
}

export function reportFatal(id: string, error: unknown): void {
  const message = sanitize(error instanceof Error ? error.message : String(error), 1000);
  console.error(`${id}: ${message}`);
  if (error instanceof StarterError && error.hint) console.error(`hint: ${error.hint}`);
}

/** Throws a workflow failure with a readable message when a check fails. */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StarterError('workflow_failed', `Check failed: ${message}`);
}
