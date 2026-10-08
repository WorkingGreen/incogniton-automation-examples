import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IncognitonMcpClient, extractJson } from '../../lib/mcp-client.js';
import type { StarterError } from '../../lib/errors.js';

test('extractJson reads the JSON block behind the prose the MCP tools return', () => {
  // Shapes observed from the hosted server.
  const search = "Found 1 matching profiles. Use the 'profile_name' from the list below:\n\n[\n {\"profile_browser_ID\": \"a\", \"profile_name\": \"x\"}\n]";
  assert.deepEqual(extractJson(search), [{ profile_browser_ID: 'a', profile_name: 'x' }]);
  assert.equal(extractJson('Launch request created successfully!\n\nRequest ID: 2205\nProfile: x'), undefined);
  assert.equal(extractJson('Launch Request #2204\nStatus: LAUNCHED'), undefined);
});

test('a missing token fails as configuration, with a hint', () => {
  assert.throws(() => new IncognitonMcpClient('https://example.invalid/mcp', ''), (e: StarterError) => e.kind === 'config_invalid' && Boolean(e.hint));
});
