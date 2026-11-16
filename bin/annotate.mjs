#!/usr/bin/env node
// annotate – koppling mellan webbläsar-överlägget och en Claude Code-session.
//
//   annotate wait --origin <o> [--origin ...]    vänta på annoteringar/val/svar, ta dem och skriv ut
//   annotate verify <id...> [--reload] [--timeout s]   be användarens flik om en efter-bild
//   annotate variants <id> "etikett A" "etikett B" [...]   varianter klara, låt användaren välja
//   annotate ask <id> "fråga"                    ställ en fråga i bubblan
//   annotate done <id> [svar...]                 markera klar (svaret visas i bubblan)
//   annotate list [--origin o] [--status s] | reopen <id> | clear-done [--origin o]
//   annotate allow-host <host>                   tillåt ett lokalt hostnamn utöver localhost, *.test, *.localhost
//   annotate server | start | stop | status
import { spawn, execSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, normalizeOrigin, readConfig, parseJson, shotPath, CONFIG, HOME, BASE } from '../lib/db.mjs';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = { origin: [], status: null, reload: false, timeout: 30 };
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--origin') flags.origin.push(normalizeOrigin(rest[++i]));
  else if (rest[i] === '--status') flags.status = rest[++i];
  else if (rest[i] === '--timeout') flags.timeout = Number(rest[++i]);
  else if (rest[i] === '--reload') flags.reload = true;
  else positional.push(rest[i]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const healthy = () => fetch(`${BASE}/health`).then((r) => r.ok, () => false);
const KEYS = ['A', 'B', 'C', 'D'];

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
  const v = parseJson(json);
  if (!v) return '-';
  return 'x' in v ? `x=${v.x} y=${v.y} w=${v.w} h=${v.h}` : `${v.w}×${v.h}`;
};

function needId(id) {
  const a = openDb().prepare('SELECT * FROM annotations WHERE id = ?').get(id);
  if (!a) { console.error(`Hittade inte #${id}.`); process.exit(1); }
  return a;
}

function printAnnotation(a) {
  console.log(`#${a.id} [${a.kind === 'area' ? 'yta' : 'element'}] ${a.origin}${a.url}`);
  console.log(`  kommentar:   ${a.comment}`);
  for (const t of parseJson(a.thread, [])) console.log(`  ${t.from === 'agent' ? 'du frågade: ' : 'svar:       '}${t.text}`);

  const variants = parseJson(a.variants, []);
  if (a.choice) {
    const v = variants.find((x) => x.key === a.choice);
    console.log(`  ★ VAL:       användaren valde ${a.choice}${v ? ` (${v.label})` : ''}. Behåll den varianten, ta bort de andra`);
    console.log(`               och cookie-switchen annotate_v${a.id}, kör sedan verify och done.`);
  } else if (a.want_variants > 1) {
    const keys = KEYS.slice(0, a.want_variants).join('/');
    console.log(`  ★ VARIANTER: användaren vill ha ${a.want_variants} varianter (${keys}). Bygg dem bakom cookien annotate_v${a.id}`);
    console.log(`               (värde ${keys}, A som standard) och kör: annotate variants ${a.id} "etikett A" "etikett B" …`);
  }

  if (a.components) console.log(`  komponenter: ${a.components}   (innerst först)`);
  console.log(`  selector:    ${a.selector ?? '-'}${a.kind === 'area' ? '   (minsta container runt ytan)' : ''}`);
  console.log(`  position:    ${fmt(a.rect)}   (viewport ${fmt(a.viewport)})`);
  if (existsSync(shotPath(a.id, 'before'))) console.log(`  före-bild:   ${shotPath(a.id, 'before')}   (det användaren såg, läs bilden)`);
  if (a.html) console.log(`  html:        ${a.html.replace(/\s+/g, ' ').slice(0, 500)}`);
  console.log();
}

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
    for (const w of openDb().prepare('SELECT * FROM watchers ORDER BY last_seen DESC').all()) {
      console.log(`  ${w.origin} → ${w.project} (senast ${Math.round((Date.now() - w.last_seen) / 1000)}s sedan)`);
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
    // Nya/besvarade annoteringar och gjorda val, plus egna som blev kvar (t.ex. efter en avbruten session).
    const pending = db.prepare(`SELECT * FROM annotations WHERE origin IN (${ph})
      AND (status IN ('open', 'chosen') OR (status IN ('working', 'verifying') AND project = ?)) ORDER BY id`);
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

    console.log(`${rows.length} annotering(ar) att hantera:\n`);
    rows.forEach(printAnnotation);
    console.log('Genomför → annotate verify <id> [--reload] → läs efter-bilden → annotate done <id> "svar"');
    break;
  }

  case 'verify': {
    if (!positional.length) throw new Error('annotate verify <id...> [--reload] [--timeout s]');
    await ensureServer();
    const db = openDb();
    const ids = positional.map(Number);
    for (const id of ids) {
      needId(id);
      rmSync(shotPath(id, 'after'), { force: true });
      db.prepare(`UPDATE annotations SET status = 'verifying', verify_round = verify_round + 1, verify_reload = ?,
                  updated_at = datetime('now') WHERE id = ?`).run(flags.reload ? 1 : 0, id);
    }
    const deadline = Date.now() + flags.timeout * 1000;
    while (Date.now() < deadline && !ids.every((id) => existsSync(shotPath(id, 'after')))) await sleep(500);
    for (const id of ids) {
      const p = shotPath(id, 'after');
      if (existsSync(p)) {
        console.log(`#${id} efter-bild: ${p}`);
        if (existsSync(shotPath(id, 'before'))) console.log(`    före-bild: ${shotPath(id, 'before')}`);
      } else {
        console.log(`#${id} ingen efter-bild inom ${flags.timeout}s. Användarens flik visar troligen inte sidan just nu.`);
        console.log('    Markera klar ändå och skriv "(ej visuellt verifierad)" i svaret.');
      }
    }
    console.log('\nLäs bilderna. Stämmer resultatet med kommentaren? Om inte: rätta och kör verify igen. Annars: annotate done.');
    break;
  }

  case 'variants': {
    const [id, ...labels] = positional;
    if (!id || labels.length < 2) throw new Error('annotate variants <id> "etikett A" "etikett B" [...]');
    needId(id);
    const variants = labels.slice(0, KEYS.length).map((label, i) => ({ key: KEYS[i], label }));
    openDb().prepare(`UPDATE annotations SET status = 'choose', variants = ?, choice = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(variants), id);
    console.log(`#${id}: ${variants.map((v) => `${v.key} = ${v.label}`).join(', ')}. Användaren väljer i bubblan, valet kommer via annotate wait.`);
    break;
  }

  case 'ask': {
    const [id, ...words] = positional;
    if (!id || !words.length) throw new Error('annotate ask <id> "fråga"');
    const a = needId(id);
    const thread = [...parseJson(a.thread, []), { from: 'agent', text: words.join(' '), at: new Date().toISOString() }];
    openDb().prepare(`UPDATE annotations SET status = 'question', thread = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(thread), id);
    console.log(`#${id}: frågan visas i bubblan. Svaret kommer via annotate wait.`);
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
    openDb().prepare(`UPDATE annotations SET status = 'draft', reply = NULL, project = NULL, choice = NULL, variants = NULL,
                      updated_at = datetime('now') WHERE id = ?`).run(positional[0]);
    console.log(`#${positional[0]} är utkast igen.`);
    break;
  }

  case 'list': {
    const where = [], args = [];
    if (flags.origin.length) { where.push(`origin IN (${flags.origin.map(() => '?').join(',')})`); args.push(...flags.origin); }
    if (flags.status) { where.push('status = ?'); args.push(flags.status); }
    const rows = openDb().prepare(`SELECT * FROM annotations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`).all(...args);
    if (!rows.length) console.log('Inga annoteringar.');
    for (const a of rows) console.log(`#${a.id} ${a.status.padEnd(9)} ${a.origin}${a.url}  ${a.comment}${a.reply ? `  → ${a.reply}` : ''}`);
    break;
  }

  case 'clear-done': {
    const db = openDb();
    const rows = flags.origin.length
      ? db.prepare(`SELECT id FROM annotations WHERE status = 'done' AND origin IN (${flags.origin.map(() => '?').join(',')})`).all(...flags.origin)
      : db.prepare(`SELECT id FROM annotations WHERE status = 'done'`).all();
    for (const { id } of rows) {
      db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
      for (const w of ['before', 'after']) rmSync(shotPath(id, w), { force: true });
    }
    console.log(`Tog bort ${rows.length} klara.`);
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
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    console.log(`\nRepo:    ${fileURLToPath(new URL('..', import.meta.url))}`);
    console.log(`Tillägg: ${fileURLToPath(new URL('../extension', import.meta.url))}`);
}
