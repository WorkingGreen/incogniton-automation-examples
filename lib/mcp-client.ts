/**
 * Minimal client for the hosted Incogniton MCP endpoint (JSON-RPC 2.0 over HTTPS, stateless
 * POSTs with a Bearer token). A repository helper, not part of any SDK. AI clients normally use
 * the published `@incogniton/mcp` stdio bridge instead; this lets scripts call the same tools.
 */
import { StarterError, sanitize } from './errors.js';

export interface McpToolResult {
  /** True when the tool reported an error (MCP `isError`). */
  isError: boolean;
  /** The tool's text content joined, as returned. */
  text: string;
  /** The JSON block inside `text` (see {@link extractJson}), else undefined. */
  json?: unknown;
}

/**
 * Incogniton's tools answer with prose followed by a JSON block ("Found 1 matching profiles ...
 * [ {...} ]"); some answers are prose only. Returns the first JSON array/object, or undefined.
 */
export function extractJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

export class IncognitonMcpClient {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly protocolVersion = '2024-11-05',
  ) {
    if (!token) {
      throw new StarterError('config_invalid', 'INCOGNITON_MCP_TOKEN is not set.', {
        hint: 'Create a token in the Incogniton app (My Account > Settings > MCP Token) and put it in .env. Never commit it.',
      });
    }
  }

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'MCP-Protocol-Version': this.protocolVersion,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new StarterError('api_unreachable', `MCP endpoint ${this.url} did not respond: ${sanitize((error as Error).message)}`);
    }
    const body = (await response.json().catch(() => undefined)) as { result?: unknown; error?: { message?: string } } | undefined;
    if (response.status === 401 || response.status === 403) {
      throw new StarterError('config_invalid', `MCP token rejected (HTTP ${response.status}).`, {
        hint: 'Regenerate the token in the Incogniton app and update INCOGNITON_MCP_TOKEN in .env.',
      });
    }
    if (!response.ok || !body) throw new StarterError('api_error', `MCP ${method} failed: HTTP ${response.status}`);
    if (body.error) throw new StarterError('api_error', `MCP ${method} error: ${sanitize(body.error.message ?? 'unknown')}`);
    return body.result;
  }

  async initialize(): Promise<{ serverInfo?: { name?: string; version?: string }; protocolVersion?: string }> {
    return (await this.rpc('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: 'incogniton-automation-examples', version: '1' },
    })) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string };
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const result = (await this.rpc('tools/list')) as { tools?: Array<{ name: string; description?: string }> };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = (await this.rpc('tools/call', { name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    return { isError: Boolean(result.isError), text, json: extractJson(text) };
  }
}
