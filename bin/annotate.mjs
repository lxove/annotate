#!/usr/bin/env node
// annotate – koppling mellan webbläsar-överlägget och en Claude Code-session.
//
//   annotate wait --origin http://localhost:3000 [--origin ...]
//        Startar servern vid behov, väntar på skickade annoteringar för de origins,
//        markerar dem 'working', skriver ut dem och avslutas.
//   annotate done <id> [svar...]       markera klar (svaret visas i bubblan)
//   annotate list [--origin o] [--status s]
//   annotate reopen <id>
//   annotate clear-done [--origin o]
//   annotate allow-host <host>         tillåt ett lokalt hostnamn utöver localhost, *.test, *.localhost
//   annotate server | start | stop | status
import { spawn, execSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, normalizeOrigin, readConfig, CONFIG, HOME, BASE } from '../lib/db.mjs';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = { origin: [], status: null };
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--origin') flags.origin.push(normalizeOrigin(rest[++i]));
  else if (rest[i] === '--status') flags.status = rest[++i];
  else positional.push(rest[i]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const healthy = () => fetch(`${BASE}/health`).then((r) => r.ok, () => false);

async function ensureServer() {
  if (await healthy()) return;
  const log = openSync(path.join(HOME, 'server.log'), 'a');
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'server'], { detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 30; i++) {
    if (await healthy()) return;
    await sleep(100);
  }
  throw new Error(`Servern startade inte, se ${path.join(HOME, 'server.log')}`);
}

function projectName() {
  try {
    return path.basename(execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
  } catch {
    return path.basename(process.cwd());
  }
}

const fmt = (json) => {
  const v = JSON.parse(json || 'null');
  if (!v) return '-';
  return 'x' in v ? `x=${v.x} y=${v.y} w=${v.w} h=${v.h}` : `${v.w}×${v.h}`;
};

switch (cmd) {
  case 'server': {
    const { startServer } = await import('../lib/server.mjs');
    startServer();
    break;
  }

  case 'start':
    await ensureServer();
    console.log(`Servern kör på ${BASE}`);
    break;

  case 'stop': {
    try {
      process.kill(Number(readFileSync(path.join(HOME, 'server.pid'), 'utf8')), 'SIGTERM');
      console.log('Servern stoppad.');
    } catch {
      console.log('Ingen server igång.');
    }
    break;
  }

  case 'status': {
    console.log(`Server: ${(await healthy()) ? `kör (${BASE})` : 'stoppad'}`);
    const ws = openDb().prepare('SELECT * FROM watchers ORDER BY last_seen DESC').all();
    for (const w of ws) {
      const age = Math.round((Date.now() - w.last_seen) / 1000);
      console.log(`  ${w.origin} → ${w.project} (senast ${age}s sedan)`);
    }
    break;
  }

  case 'wait': {
    if (!flags.origin.length) {
      console.error('Ange minst en --origin, t.ex. annotate wait --origin http://localhost:3000');
      process.exit(2);
    }
    await ensureServer();
    const db = openDb();
    const project = projectName();
    const ph = flags.origin.map(() => '?').join(',');
    const heartbeat = db.prepare(`INSERT INTO watchers (origin, project, cwd, last_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT(origin) DO UPDATE SET project = excluded.project, cwd = excluded.cwd, last_seen = excluded.last_seen`);
    // Skickade annoteringar, plus egna som blev kvar på 'working' (t.ex. efter en avbruten session).
    const pending = db.prepare(`SELECT * FROM annotations WHERE origin IN (${ph})
      AND (status = 'open' OR (status = 'working' AND project = ?)) ORDER BY id`);
    const claim = db.prepare(`UPDATE annotations SET status = 'working', project = ?, updated_at = datetime('now') WHERE id = ?`);

    let rows;
    for (;;) {
      if (process.ppid === 1) process.exit(0); // föräldern (sessionen) är borta
      for (const o of flags.origin) heartbeat.run(o, project, process.cwd(), Date.now());
      rows = pending.all(...flags.origin, project);
      if (rows.length) break;
      await sleep(500);
    }
    for (const r of rows) claim.run(project, r.id);

    console.log(`${rows.length} annotering(ar) att genomföra:\n`);
    for (const a of rows) {
      console.log(`#${a.id} [${a.kind === 'area' ? 'yta' : 'element'}] ${a.origin}${a.url}`);
      console.log(`  kommentar:   ${a.comment}`);
      if (a.components) console.log(`  komponenter: ${a.components}   (innerst först)`);
      console.log(`  selector:    ${a.selector ?? '-'}${a.kind === 'area' ? '   (minsta container runt ytan)' : ''}`);
      console.log(`  position:    ${fmt(a.rect)}   (viewport ${fmt(a.viewport)})`);
      if (a.html) console.log(`  html:        ${a.html.replace(/\s+/g, ' ').slice(0, 500)}`);
      console.log();
    }
    console.log('Markera klar: annotate done <id> "kort beskrivning av vad du gjorde"');
    break;
  }

  case 'done': {
    const [id, ...reply] = positional;
    if (!id) throw new Error('annotate done <id> [svar]');
    const r = openDb().prepare(`UPDATE annotations SET status = 'done', reply = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(reply.join(' ') || null, id);
    console.log(r.changes ? `#${id} klar.` : `Hittade inte #${id}.`);
    break;
  }

  case 'reopen': {
    openDb().prepare(`UPDATE annotations SET status = 'draft', reply = NULL, project = NULL, updated_at = datetime('now') WHERE id = ?`).run(positional[0]);
    console.log(`#${positional[0]} är utkast igen.`);
    break;
  }

  case 'list': {
    const where = [], args = [];
    if (flags.origin.length) { where.push(`origin IN (${flags.origin.map(() => '?').join(',')})`); args.push(...flags.origin); }
    if (flags.status) { where.push('status = ?'); args.push(flags.status); }
    const rows = openDb().prepare(`SELECT * FROM annotations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`).all(...args);
    if (!rows.length) console.log('Inga annoteringar.');
    for (const a of rows) console.log(`#${a.id} ${a.status.padEnd(7)} ${a.origin}${a.url}  ${a.comment}${a.reply ? `  → ${a.reply}` : ''}`);
    break;
  }

  case 'clear-done': {
    const db = openDb();
    const r = flags.origin.length
      ? db.prepare(`DELETE FROM annotations WHERE status = 'done' AND origin IN (${flags.origin.map(() => '?').join(',')})`).run(...flags.origin)
      : db.prepare(`DELETE FROM annotations WHERE status = 'done'`).run();
    console.log(`Tog bort ${r.changes} klara.`);
    break;
  }

  // Tillåt ett hostnamn i både servern (config.json) och tillägget (manifest.json).
  case 'allow-host': {
    const host = positional[0] && new URL(normalizeOrigin(positional[0])).hostname;
    if (!host) throw new Error('annotate allow-host <host>, t.ex. annotate allow-host myapp.local');
    const cfg = readConfig();
    if (!cfg.hosts.includes(host)) cfg.hosts.push(host);
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');

    const manifestPath = fileURLToPath(new URL('../extension/manifest.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const cs of manifest.content_scripts) {
      if (!cs.matches.includes(`*://${host}/*`)) cs.matches.push(`*://${host}/*`);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`${host} tillåten. Ladda om tillägget (↻ i chrome://extensions) och sedan sidan.`);
    break;
  }

  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    console.log(`\nRepo:    ${fileURLToPath(new URL('..', import.meta.url))}`);
    console.log(`Tillägg: ${fileURLToPath(new URL('../extension', import.meta.url))}`);
}
