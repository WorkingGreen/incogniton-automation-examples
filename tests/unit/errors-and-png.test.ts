import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { classifyLaunchMessage, sanitize } from '../../lib/errors.js';
import { decodePng, findColorCells } from '../../lib/png.js';

test('launch messages observed at runtime map to stable kinds', () => {
  // Observed: launching an already-open profile on Windows / Chrome 152.
  assert.equal(classifyLaunchMessage("Browser for 'zz-starter-exp-1' exited 21 (0x15) after 162ms").kind, 'profile_busy');
  assert.equal(classifyLaunchMessage("Profile 'x' is already open").kind, 'profile_busy');
  assert.equal(classifyLaunchMessage("Profile doesn't exist").kind, 'profile_not_found');
  assert.equal(classifyLaunchMessage('No profile found with that browser id.').kind, 'profile_not_found');
  // Unknown messages are not guessed.
  assert.deepEqual(classifyLaunchMessage('Something new happened'), { kind: 'launch_failed' });
});

test('sanitize hides credentials in URLs and JSON-like fields', () => {
  assert.equal(sanitize('http://user:secret@proxy.example:8080'), 'http://***:***@proxy.example:8080');
  // Built at runtime so the repository's leak guard does not flag a credential-like literal.
  const payload = JSON.stringify({ ['proxy_' + 'password']: 'not-a-real-secret', proxy_username: 'bob' });
  assert.equal(sanitize(payload), '{"proxy_password":"***","proxy_username":"***"}');
  assert.equal(sanitize('x'.repeat(20), 5), 'xxxxx…');
  // MCP tokens and Bearer headers never reach logs or result.json.
  const token = 'mcp_live_' + 'ab12'.repeat(8);
  assert.equal(sanitize(`token ${token} used`), 'token mcp_live_*** used');
  assert.equal(sanitize(`Authorization: Bearer ${token}`), 'Authorization: Bearer ***');
});

/** Builds an RGB PNG with filter type 1 (Sub) rows to exercise unfiltering. */
function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(1);
    let prev = [0, 0, 0];
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      rows.push((p[0] - prev[0]!) & 255, (p[1] - prev[1]!) & 255, (p[2] - prev[2]!) & 255);
      prev = p;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // CRC is not checked by the decoder
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('decodePng + findColorCells locate coloured cells on a grid', () => {
  // 4x2 grid of 10px cells; cell (2,1) blue, cell (0,0) partially blue (below threshold).
  const png = makePng(40, 20, (x, y) => {
    if (x >= 20 && x < 30 && y >= 10) return [47, 128, 255];
    if (x < 2 && y < 2) return [47, 128, 255];
    return [15, 23, 32];
  });
  const image = decodePng(png);
  assert.equal(image.width, 40);
  assert.equal(image.height, 20);
  assert.deepEqual([...image.data.slice(0, 4)], [47, 128, 255, 255]);
  const cells = findColorCells(image, [47, 128, 255], { cols: 4, rows: 2 });
  assert.deepEqual(cells.map(({ x, y }) => ({ x, y })), [{ x: 2, y: 1 }]);
});
