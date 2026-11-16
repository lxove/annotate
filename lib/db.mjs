// Gemensam SQLite-databas för alla repon: ~/.annotate/annotations.db
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.ANNOTATE_HOME || path.join(os.homedir(), '.annotate');
export const PORT = Number(process.env.ANNOTATE_PORT || 4747);
export const BASE = `http://127.0.0.1:${PORT}`;
export const SHOTS = path.join(HOME, 'shots');
mkdirSync(SHOTS, { recursive: true });

// Skärmdumpar tagna av tillägget i användarens flik: 'before' (när annoteringen skapas)
// och 'after' (när agenten kör `annotate verify`).
export const shotPath = (id, which) => path.join(SHOTS, `${Number(id)}-${which}.png`);

// Kolumner som tillkommit efter första versionen läggs till i befintliga databaser.
const LATER_COLUMNS = [
  ['want_variants', 'INTEGER NOT NULL DEFAULT 1'], // antal varianter användaren bad om (1–3)
  ['variants', 'TEXT'],                            // JSON [{key, label}] när agenten byggt varianter
  ['choice', 'TEXT'],                              // vald variant ('A', 'B', …)
  ['thread', 'TEXT'],                              // JSON [{from: 'agent'|'user', text, at}]
  ['verify_round', 'INTEGER NOT NULL DEFAULT 0'],  // ökas för varje `annotate verify`
  ['verify_reload', 'INTEGER NOT NULL DEFAULT 0'], // ladda om sidan före efter-bilden (appar utan HMR)
];

export function openDb() {
  const db = new DatabaseSync(path.join(HOME, 'annotations.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;

    -- status: draft -> open (skickad) -> working (en session jobbar) -> verifying -> done
    --         working -> choose (varianter klara) -> chosen (användaren valt) -> working
    --         working -> question (agenten frågar) -> open (användaren svarat)
    CREATE TABLE IF NOT EXISTS annotations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      origin     TEXT NOT NULL,          -- t.ex. http://localhost:3000
      url        TEXT NOT NULL,          -- path + query
      kind       TEXT NOT NULL,          -- 'element' | 'area'
      selector   TEXT,
      components TEXT,                   -- React-komponenter, innerst först
      rect       TEXT,                   -- JSON {x,y,w,h} i dokumentkoordinater
      viewport   TEXT,                   -- JSON {w,h}
      html       TEXT,
      comment    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'draft',
      project    TEXT,                   -- repot som tog annoteringen
      reply      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS annotations_origin_status ON annotations (origin, status);

    -- Vilket repo lyssnar på vilken origin (uppdateras av "annotate wait").
    CREATE TABLE IF NOT EXISTS watchers (
      origin    TEXT PRIMARY KEY,
      project   TEXT NOT NULL,
      cwd       TEXT NOT NULL,
      last_seen INTEGER NOT NULL          -- epoch ms
    );
  `);
  const cols = new Set(db.prepare('PRAGMA table_info(annotations)').all().map((c) => c.name));
  for (const [name, def] of LATER_COLUMNS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE annotations ADD COLUMN ${name} ${def}`);
  }
  return db;
}

export const parseJson = (s, fallback = null) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

export function normalizeOrigin(o) {
  return new URL(o.includes('://') ? o : `http://${o}`).origin;
}

// Extra hostnamn (utöver standard nedan) läggs till med `annotate allow-host`.
export const CONFIG = path.join(HOME, 'config.json');
export function readConfig() {
  try {
    return { hosts: [], ...JSON.parse(readFileSync(CONFIG, 'utf8')) };
  } catch {
    return { hosts: [] };
  }
}

// Bara sidor på den egna maskinen får skriva annoteringar. .localhost och .test är
// reserverade toppdomäner (RFC 6761/2606) som bara kan peka hit via lokal konfiguration.
export function isAllowedOrigin(o) {
  try {
    const { hostname } = new URL(o);
    if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return true;
    if (/\.(localhost|test)$/.test(hostname)) return true;
    return readConfig().hosts.includes(hostname);
  } catch {
    return false;
  }
}
