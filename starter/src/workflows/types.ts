import type { BrowserContext, Page } from 'playwright-core';
import type { StarterConfig } from '../../../lib/config.js';
import type { FixtureServer } from '../../../lib/fixture-server.js';
import type { Log } from '../../../lib/incogniton.js';

/** Everything a workflow receives. The session lifecycle is handled for you. */
export interface WorkflowContext {
  /** A new tab in the profile's persistent default context. */
  page: Page;
  /** The profile's persistent default context (cookies, storage). */
  context: BrowserContext;
  profileId: string;
  config: StarterConfig;
  /** Local fixture pages; replace with your own target URLs. */
  fixtures: FixtureServer;
  /** Path for an artifact in this run's output directory (recorded in result.json). */
  artifact(name: string): string;
  log: Log;
  /** Aborted on Ctrl+C / SIGTERM: check it between long steps. */
  signal: AbortSignal;
}

export interface WorkflowResult {
  /** One line printed on success and stored in result.json. */
  summary: string;
  /** Non-sensitive facts to store in result.json. */
  details?: Record<string, unknown>;
}

export interface Workflow {
  name: string;
  description: string;
  run(ctx: WorkflowContext): Promise<WorkflowResult>;
}
