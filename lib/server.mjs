// Liten HTTP-server som överlägget pratar med. Binder bara till 127.0.0.1 och
// accepterar bara anrop från lokala origins, så att en godtycklig webbplats
// inte kan skicka "instruktioner" till din Claude-session.
import http from 'node:http';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openDb, PORT, HOME, isAllowedOrigin, normalizeOrigin, shotPath, parseJson } from './db.mjs';

const OVERLAY = new URL('../extension/overlay.js', import.meta.url);
const LISTENING_MS = 15_000;
const MAX_BODY = 20 * 1024 * 1024; // skärmdumpar som base64

export function startServer() {
  const db = openDb();
  const q = {
    list: db.prepare('SELECT * FROM annotations WHERE origin = ? ORDER BY id'),
    get: db.prepare('SELECT * FROM annotations WHERE id = ? AND origin = ?'),
    insert: db.prepare(`INSERT INTO annotations (origin, url, kind, selector, components, rect, viewport, html, comment, want_variants)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    submit: db.prepare(`UPDATE annotations SET status = 'open', updated_at = datetime('now') WHERE origin = ? AND status = 'draft'`),
    del: db.prepare('DELETE FROM annotations WHERE id = ? AND origin = ?'),
    watcher: db.prepare('SELECT * FROM watchers WHERE origin = ?'),
    choose: db.prepare(`UPDATE annotations SET status = 'chosen', choice = ?, updated_at = datetime('now') WHERE id = ? AND status = 'choose'`),
    answer: db.prepare(`UPDATE annotations SET status = 'open', thread = ?, updated_at = datetime('now') WHERE id = ? AND status = 'question'`),
    edit: db.prepare(`UPDATE annotations SET comment = ?, updated_at = datetime('now') WHERE id = ? AND status = 'draft'`),
    reopen: db.prepare(`UPDATE annotations SET status = 'draft', reply = NULL, project = NULL, choice = NULL, variants = NULL,
                        updated_at = datetime('now') WHERE id = ? AND status = 'done'`),
  };
  const withShots = (a) => ({
    ...a,
    has_before: existsSync(shotPath(a.id, 'before')),
    has_after: existsSync(shotPath(a.id, 'after')),
  });

  const server = http.createServer(async (req, res) => {
    const reqOrigin = req.headers.origin;
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, {
        'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8`,
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

      // Allt nedan kräver en tillåten origin, och en annotering nås bara från sin egen origin.
      if (!reqOrigin || !isAllowedOrigin(reqOrigin)) {
        return send(403, { error: 'Endast lokala sidor (localhost, *.test, *.localhost eller annotate allow-host)' });
      }
      const origin = normalizeOrigin(reqOrigin);
      const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : {};

      if (req.method === 'GET' && url.pathname === '/annotations') return send(200, q.list.all(origin).map(withShots));

      if (req.method === 'GET' && url.pathname === '/status') {
        const w = q.watcher.get(origin);
        return send(200, w ? { project: w.project, listening: Date.now() - w.last_seen < LISTENING_MS } : { project: null, listening: false });
      }

      if (req.method === 'POST' && url.pathname === '/annotations') {
        const want = Math.min(3, Math.max(1, Number(body.want_variants) || 1));
        const r = q.insert.run(origin, String(body.url ?? '/'), body.kind === 'area' ? 'area' : 'element', body.selector ?? null,
          body.components ?? null, JSON.stringify(body.rect ?? null), JSON.stringify(body.viewport ?? null), body.html ?? null,
          String(body.comment ?? ''), want);
        return send(200, { id: Number(r.lastInsertRowid) });
      }

      if (req.method === 'POST' && url.pathname === '/annotations/submit') {
        return send(200, { submitted: Number(q.submit.run(origin).changes) });
      }

      const m = url.pathname.match(/^\/annotations\/(\d+)(?:\/(shot|choose|answer|reopen)(?:\/(before|after))?)?$/);
      if (!m) return send(404, { error: 'Not found' });
      const [, id, action, which] = m;
      const a = q.get.get(id, origin);
      if (!a) return send(404, { error: 'Hittade inte annoteringen' });

      if (!action && req.method === 'DELETE') {
        q.del.run(id, origin);
        for (const w of ['before', 'after']) rmSync(shotPath(id, w), { force: true });
        return send(200, { deleted: 1 });
      }
      if (!action && req.method === 'PATCH') {
        return send(200, { updated: Number(q.edit.run(String(body.comment ?? a.comment), id).changes) });
      }
      if (action === 'reopen' && req.method === 'POST') return send(200, { updated: Number(q.reopen.run(id).changes) });

      if (action === 'shot' && req.method === 'POST') {
        const w = body.which === 'after' ? 'after' : 'before';
        const b64 = String(body.dataUrl ?? '').replace(/^data:image\/png;base64,/, '');
        if (!b64) return send(400, { error: 'dataUrl saknas' });
        writeFileSync(shotPath(id, w), Buffer.from(b64, 'base64'));
        return send(200, { ok: true });
      }
      if (action === 'shot' && req.method === 'GET' && which) {
        const p = shotPath(id, which);
        return existsSync(p) ? send(200, readFileSync(p), 'image/png') : send(404, { error: 'Ingen skärmdump' });
      }

      if (action === 'choose' && req.method === 'POST') {
        const keys = parseJson(a.variants, []).map((v) => v.key);
        if (!keys.includes(body.choice)) return send(400, { error: 'Okänd variant' });
        return send(200, { updated: Number(q.choose.run(body.choice, id).changes) });
      }

      if (action === 'answer' && req.method === 'POST') {
        const text = String(body.text ?? '').trim();
        if (!text) return send(400, { error: 'Tomt svar' });
        const thread = [...parseJson(a.thread, []), { from: 'user', text, at: new Date().toISOString() }];
        return send(200, { updated: Number(q.answer.run(JSON.stringify(thread), id).changes) });
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
  for await (const c of req) {
    s += c;
    if (s.length > MAX_BODY) throw new Error('För stor request');
  }
  return s ? JSON.parse(s) : {};
}
