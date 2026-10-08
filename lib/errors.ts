/**
 * Failure categories used by every example, the doctor and the starter.
 *
 * These are repository helpers, not Incogniton SDK exports. Each kind maps to a
 * documented process exit code (see docs/troubleshooting.md) so scripts and
 * coding agents can branch on the cause without parsing log text.
 */
import { APIError, HttpError, TimeoutError } from 'incogniton';

export type FailureKind =
  | 'config_invalid'
  | 'api_unreachable'
  | 'api_error'
  | 'profile_not_found'
  | 'profile_busy'
  | 'launch_failed'
  | 'connect_failed'
  | 'timeout'
  | 'workflow_failed'
  | 'cleanup_failed'
  | 'cancelled'
  | 'unknown';

export const EXIT_CODES: Record<FailureKind | 'ok', number> = {
  ok: 0,
  workflow_failed: 1,
  config_invalid: 2,
  api_unreachable: 3,
  profile_not_found: 4,
  profile_busy: 5,
  launch_failed: 6,
  connect_failed: 7,
  cleanup_failed: 8,
  api_error: 9,
  timeout: 10,
  unknown: 11,
  cancelled: 130,
};

export class StarterError extends Error {
  readonly kind: FailureKind;
  readonly hint?: string;

  constructor(kind: FailureKind, message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StarterError';
    this.kind = kind;
    this.hint = options.hint;
  }
}

/** Returns the failure kind for any thrown value; unknown errors stay `unknown`. */
export function failureKindOf(error: unknown): FailureKind {
  if (error instanceof StarterError) return error.kind;
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return 'unknown';
}

/**
 * Converts errors thrown by the published `incogniton` npm SDK (1.0.x) into
 * StarterErrors. The SDK throws `HttpError` when no HTTP response arrived,
 * `TimeoutError` on request timeouts and `APIError` on non-2xx responses.
 */
export function fromSdkError(error: unknown, action: string, port: number): StarterError {
  if (error instanceof StarterError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // The SDK's HttpError/TimeoutError do not set `name`, so use instanceof; HttpError
  // carries the network error code in `axios_code`.
  const code = (error as { axios_code?: string }).axios_code ?? findErrorCode(error);
  if (error instanceof HttpError || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return new StarterError('api_unreachable', `${action}: Incogniton API did not respond on 127.0.0.1:${port} (${code ?? message}).`, {
      hint: 'Start the Incogniton desktop app, log in, and check Settings > Automation (API enabled, port). Run `npm run doctor`.',
      cause: error,
    });
  }
  if (error instanceof TimeoutError) {
    return new StarterError('timeout', `${action}: request to the Incogniton API timed out.`, { cause: error });
  }
  if (error instanceof APIError) {
    return new StarterError('api_error', `${action}: Incogniton API returned an HTTP error (${message}).`, { cause: error });
  }
  return new StarterError('unknown', `${action}: ${message}`, { cause: error });
}

function findErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const record = current as { code?: unknown; cause?: unknown; error?: unknown };
    if (typeof record.code === 'string') return record.code;
    current = record.cause ?? record.error;
  }
  return undefined;
}

/**
 * Classifies the `message` of an `{"status":"error"}` launch response.
 * Only messages observed at runtime or present in the public API docs are
 * mapped; anything else stays a generic `launch_failed` with the raw message.
 */
export function classifyLaunchMessage(message: string): { kind: FailureKind; hint?: string } {
  if (/doesn't exist|no profile found/i.test(message)) {
    return { kind: 'profile_not_found', hint: 'Run `npm run profiles -- list` and copy a profile ID into .env.' };
  }
  if (/already open|not in ready state|exited 21\b/i.test(message)) {
    return {
      kind: 'profile_busy',
      hint:
        'The profile is already running. Close it in the Incogniton app, or attach to a session this starter launched (see attach-to-running-profile). ' +
        'After this error the app may report the profile as Ready although its browser is still open.',
    };
  }
  if (/limit/i.test(message)) return { kind: 'launch_failed', hint: 'Your plan or account reached a launch limit.' };
  if (/out of sync/i.test(message)) {
    return { kind: 'launch_failed', hint: 'The local and cloud copies differ. Decide explicitly which copy to keep in the app; this starter never forces local or cloud.' };
  }
  if (/not installed/i.test(message)) {
    return { kind: 'launch_failed', hint: 'Open the profile once from the Incogniton app so it downloads the browser version, or pick an installed version.' };
  }
  return { kind: 'launch_failed' };
}

/** Message text that is safe to print: no URLs with credentials, no long payloads. */
export function sanitize(text: string, max = 500): string {
  const cleaned = text
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***:***@')
    .replace(/("?(?:proxy_)?(?:password|username|token|cookie)"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
