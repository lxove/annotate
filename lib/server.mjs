// Liten HTTP-server som överlägget pratar med. Binder bara till 127.0.0.1 och
// accepterar bara anrop från localhost-sidor, så att en godtycklig webbplats
// inte kan skicka "instruktioner" till din Claude-session.
import http from 'node:http';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openDb, PORT, HOME, isAllowedOrigin, normalizeOrigin } from './db.mjs';

const OVERLAY = new URL('../extension/overlay.js', import.meta.url);
const LISTENING_MS = 15_000;

export function startServer() {
  const db = openDb();
  const q = {
    list: db.prepare('SELECT * FROM annotations WHERE origin = ? ORDER BY id'),
    insert: db.prepare(`INSERT INTO annotations (origin, url, kind, selector, components, rect, viewport, html, comment)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    submit: db.prepare(`UPDATE annotations SET status = 'open', updated_at = datetime('now') WHERE origin = ? AND status = 'draft'`),
    del: db.prepare('DELETE FROM annotations WHERE id = ? AND origin = ?'),
    watcher: db.prepare('SELECT * FROM watchers WHERE origin = ?'),
  };

  const server = http.createServer(async (req, res) => {
    const reqOrigin = req.headers.origin;
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, {
        'Content-Type': `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
        ...(reqOrigin && isAllowedOrigin(reqOrigin) && {
          'Access-Control-Allow-Origin': reqOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Private-Network': 'true',
        }),
      });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };

    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'OPTIONS') return send(204, '', 'text/plain');
      if (url.pathname === '/health') return send(200, { ok: true });
      if (url.pathname === '/overlay.js') return send(200, readFileSync(OVERLAY, 'utf8'), 'text/javascript');

      // Allt nedan kräver en localhost-origin.
      if (!reqOrigin || !isAllowedOrigin(reqOrigin)) return send(403, { error: 'Endast lokala sidor (localhost, *.test, *.localhost eller annotate allow-host)' });
      const origin = normalizeOrigin(reqOrigin);
      const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : {};

      if (req.method === 'GET' && url.pathname === '/annotations') return send(200, q.list.all(origin));

      if (req.method === 'GET' && url.pathname === '/status') {
        const w = q.watcher.get(origin);
        return send(200, w ? { project: w.project, listening: Date.now() - w.last_seen < LISTENING_MS } : { project: null, listening: false });
      }

      if (req.method === 'POST' && url.pathname === '/annotations') {
        const r = q.insert.run(origin, body.url, body.kind, body.selector ?? null, body.components ?? null,
          JSON.stringify(body.rect ?? null), JSON.stringify(body.viewport ?? null), body.html ?? null, String(body.comment ?? ''));
        return send(200, { id: Number(r.lastInsertRowid) });
      }

      if (req.method === 'POST' && url.pathname === '/annotations/submit') {
        return send(200, { submitted: Number(q.submit.run(origin).changes) });
      }

      const m = url.pathname.match(/^\/annotations\/(\d+)$/);
      if (m && req.method === 'DELETE') return send(200, { deleted: Number(q.del.run(m[1], origin).changes) });
      if (m && req.method === 'PATCH') {
        const fields = ['comment', 'status', 'reply'].filter((f) => f in body);
        if (!fields.length) return send(200, { updated: 0 });
        const sql = `UPDATE annotations SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ? AND origin = ?`;
        return send(200, { updated: Number(db.prepare(sql).run(...fields.map((f) => body[f]), m[1], origin).changes) });
      }

      send(404, { error: 'Not found' });
    } catch (err) {
      console.error(err);
      send(500, { error: String(err.message || err) });
    }
  });

  const pidFile = path.join(HOME, 'server.pid');
  server.listen(PORT, '127.0.0.1', () => {
    writeFileSync(pidFile, String(process.pid));
    console.log(`annotate-server lyssnar på http://127.0.0.1:${PORT}`);
  });
  const stop = () => { try { rmSync(pidFile); } catch {} process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function readJson(req) {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}
