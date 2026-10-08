/**
 * Local fixture server used by the examples and tests.
 *
 * Serves ./fixtures on 127.0.0.1 at fixed ports so origins (and therefore
 * cookies/localStorage) stay identical across runs. If a fixture server from
 * this repository is already listening on a port (for example started by
 * another example run), it is reused instead of failing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StarterError } from './errors.js';

export const FIXTURE_ROOT = resolve(fileURLToPath(new URL('../fixtures/', import.meta.url)));
const FIXTURE_ID = 'incogniton-automation-fixtures';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Deterministic catalogue served by /api/products (25 items, 10 per page). */
export function fixtureProducts() {
  return Array.from({ length: 25 }, (_, index) => {
    const n = index + 1;
    return { sku: `SKU-${String(n).padStart(3, '0')}`, name: `Fixture product ${n}`, price: Math.round((n * 3.5 + 1.99) * 100) / 100 };
  });
}

export const REPORT_CSV = 'id,name,score\n1,Ada,98\n2,Grace,95\n3,Linus,91\n';
// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    response.end(body);
  };
  if (url.pathname === '/__fixture') return send(200, MIME['.json']!, JSON.stringify({ name: FIXTURE_ID, version: 1 }));
  if (url.pathname === '/api/quote') return send(200, MIME['.json']!, JSON.stringify({ text: 'Served by the fixture server', source: 'network' }));
  if (url.pathname === '/pixel.gif') return send(200, 'image/gif', PIXEL);
  if (url.pathname === '/download/report.csv') {
    return send(200, MIME['.csv']!, REPORT_CSV, { 'content-disposition': 'attachment; filename="report.csv"' });
  }
  if (url.pathname === '/api/products') {
    const all = fixtureProducts();
    const pages = Math.ceil(all.length / 10);
    const page = Math.min(pages, Math.max(1, Number(url.searchParams.get('page')) || 1));
    // Small delay so pagination needs a real wait condition.
    await new Promise((r) => setTimeout(r, 150));
    return send(200, MIME['.json']!, JSON.stringify({ page, pages, items: all.slice((page - 1) * 10, page * 10) }));
  }
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = normalize(join(FIXTURE_ROOT, relative));
  if (!file.startsWith(FIXTURE_ROOT + sep)) return send(403, 'text/plain', 'Forbidden');
  try {
    const body = await readFile(file);
    return send(200, MIME[extname(file)] ?? 'application/octet-stream', body);
  } catch {
    return send(404, 'text/plain', 'Not found');
  }
}

async function isFixtureServer(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__fixture`, { signal: AbortSignal.timeout(1500) });
    return response.ok && ((await response.json()) as { name?: string }).name === FIXTURE_ID;
  } catch {
    return false;
  }
}

function listen(port: number): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      handle(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

export interface FixtureServer {
  /** e.g. http://127.0.0.1:47811 */
  origin: string;
  crossOrigin: string;
  url(path: string): string;
  close(): Promise<void>;
}

/** Starts (or reuses) the fixture server on both configured ports. */
export async function startFixtureServer(ports: { fixturePort: number; fixtureCrossOriginPort: number }): Promise<FixtureServer> {
  const servers: Server[] = [];
  for (const port of [ports.fixturePort, ports.fixtureCrossOriginPort]) {
    try {
      servers.push(await listen(port));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await isFixtureServer(port))) continue; // reuse
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      throw new StarterError('config_invalid', `Fixture port ${port} is in use by another program.`, {
        hint: 'Set FIXTURE_PORT / FIXTURE_CROSS_ORIGIN_PORT in .env to free ports. Note: changing FIXTURE_PORT changes the storage origin.',
      });
    }
  }
  const origin = `http://127.0.0.1:${ports.fixturePort}`;
  return {
    origin,
    crossOrigin: `http://127.0.0.1:${ports.fixtureCrossOriginPort}`,
    url: (path: string) => `${origin}/${path.replace(/^\/+/, '')}`,
    close: async () => {
      await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
    },
  };
}
