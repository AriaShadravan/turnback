import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Store } from '../core/store.js';
import { UI_PAGE } from './page.js';

/** Larger diffs are cut so the browser tab stays responsive; the CLI prints the full patch. */
export const MAX_UI_DIFF_CHARS = 400_000;

export interface UiServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Read-only local timeline. It listens on 127.0.0.1 only, every path starts with a random token,
 * only GET is served, and the Host header must be local, so other websites cannot read or change
 * anything (including through DNS rebinding).
 */
export function startUi(store: Store, port = 0): Promise<UiServer> {
  const token = randomBytes(16).toString('hex');
  const prefix = `/${token}/`;
  let listening = 0;

  const server = createServer((req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${listening}` && host !== `localhost:${listening}`) return send(res, 403, 'text/plain', 'Forbidden');
      if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (!pathname.startsWith(prefix)) return send(res, 404, 'text/plain', 'Not found');
      const route = pathname.slice(prefix.length);

      if (route === '') return send(res, 200, 'text/html; charset=utf-8', UI_PAGE);
      if (route === 'api/turns') {
        return json(res, { workspace: store.root, turns: store.turns().map(t => store.summarize(t)), marks: store.marks() });
      }
      const match = /^api\/turns\/([^/]+)\/(diff|steps)$/.exec(route);
      const turn = match && store.findTurn(decodeURIComponent(match[1]));
      if (!match || !turn) return send(res, 404, 'text/plain', 'Not found');
      if (match[2] === 'steps') return json(res, { steps: store.steps(turn.id) });
      const diff = turn.end ? store.turnDiff(turn.id, true).diff : '';
      return json(res, { diff: diff.slice(0, MAX_UI_DIFF_CHARS), truncated: diff.length > MAX_UI_DIFF_CHARS });
    } catch (e) {
      send(res, 500, 'text/plain', e instanceof Error ? e.message : String(e));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      listening = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${listening}${prefix}`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(body);
}

const json = (res: ServerResponse, value: unknown) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(value));
