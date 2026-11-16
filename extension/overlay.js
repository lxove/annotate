// Annoteringsöverlägg för lokala dev-sidor.
// Laddas av Chrome-tillägget (eller som <script src="http://127.0.0.1:4747/overlay.js">,
// då utan skärmdumpar och komponentnamn). Syns bara när annotate-servern kör.
//   ✎ eller Alt+A  – slå på/av annoteringsläge
//   klick          – kommentera ett element
//   dra            – rita en yta och kommentera den
//   Skicka         – skickar utkasten till Claude-sessionen som lyssnar på den här origin
//   Esc            – stäng bubbla / lämna läget
(() => {
  if (window.top !== window || document.documentElement.hasAttribute('data-annotate')) return;
  document.documentElement.setAttribute('data-annotate', '');

  const API = window.__ANNOTATE_API || 'http://127.0.0.1:4747';
  const COLORS = {
    draft: '#3b82f6', open: '#f59e0b', chosen: '#f59e0b', working: '#8b5cf6', verifying: '#8b5cf6',
    choose: '#ec4899', question: '#ec4899', done: '#10b981',
  };
  const LABELS = {
    draft: 'utkast', open: 'i kö', chosen: 'valt, i kö', working: 'pågår', verifying: 'kontrolleras',
    choose: 'välj variant', question: 'fråga till dig', done: 'klar',
  };
  const NEEDS_YOU = new Set(['choose', 'question']);
  const BUSY = new Set(['working', 'verifying']);

  // ---------- DOM (shadow root så sidans CSS inte läcker in) ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;display:none;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, sans-serif; }
    .hl { position: fixed; pointer-events: none; border: 2px solid #3b82f6; background: rgba(59,130,246,.08); border-radius: 3px; }
    .drag { position: fixed; pointer-events: none; border: 2px dashed #3b82f6; background: rgba(59,130,246,.10); }
    .area { position: absolute; pointer-events: none; border: 2px dashed; border-radius: 4px; }
    .pin { position: absolute; min-width: 24px; height: 24px; margin: -12px 0 0 -12px; padding: 0 4px; border-radius: 12px 12px 12px 0;
           color: #fff; font-weight: 600; font-size: 12px; display: grid; place-items: center; cursor: pointer;
           box-shadow: 0 2px 6px rgba(0,0,0,.3); border: 2px solid #fff; transition: transform .1s; }
    .pin:hover { transform: scale(1.15); }
    .pin.done { opacity: .55; }
    .pin.working, .pin.verifying { animation: pulse 1.2s infinite; }
    .pin.choose, .pin.question { animation: attention 1s infinite; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(139,92,246,.35); } }
    @keyframes attention { 50% { box-shadow: 0 0 0 8px rgba(236,72,153,.35); } }
    .card { position: absolute; width: 340px; background: #fff; color: #111; border-radius: 10px; padding: 10px;
            box-shadow: 0 8px 30px rgba(0,0,0,.25); border: 1px solid #e5e7eb; }
    .card textarea { width: 100%; min-height: 70px; resize: vertical; border: 1px solid #d1d5db; border-radius: 6px;
                     padding: 6px 8px; outline: none; color: #111; background: #fff; }
    .card textarea:focus { border-color: #3b82f6; }
    .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; align-items: center; flex-wrap: wrap; }
    .row .hint { margin-right: auto; color: #6b7280; font-size: 11px; }
    button { border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; background: #f3f4f6; color: #111; }
    button.primary { background: #3b82f6; color: #fff; }
    button.pink { background: #ec4899; color: #fff; }
    button.danger { background: #fee2e2; color: #b91c1c; }
    .seg { display: inline-flex; border: 1px solid #d1d5db; border-radius: 6px; overflow: hidden; }
    .seg button { border-radius: 0; padding: 3px 9px; background: #fff; }
    .seg button.on { background: #3b82f6; color: #fff; }
    .meta { color: #6b7280; font-size: 11px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bubble { margin-top: 6px; padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; }
    .bubble.agent { background: #fdf2f8; color: #831843; }
    .bubble.user { background: #eff6ff; color: #1e3a8a; }
    .reply { margin-top: 6px; padding: 6px 8px; background: #ecfdf5; border-radius: 6px; color: #065f46; white-space: pre-wrap; }
    .comment { white-space: pre-wrap; }
    .variants { display: grid; gap: 6px; margin-top: 8px; }
    .variant { text-align: left; padding: 7px 9px; border: 2px solid #e5e7eb; background: #fff; }
    .variant.on { border-color: #ec4899; background: #fdf2f8; }
    .variant b { margin-right: 6px; }
    .shot { margin-top: 8px; }
    .shot img { display: block; max-width: 100%; max-height: 260px; border: 1px solid #e5e7eb; border-radius: 6px; }
    .shot .tabs { display: flex; gap: 4px; margin-bottom: 4px; }
    .shot .tabs button { padding: 2px 8px; font-size: 11px; }
    .shot .tabs button.on { background: #111827; color: #fff; }
    .bar { position: fixed; right: 16px; bottom: 16px; display: flex; gap: 8px; align-items: center;
           background: #111827; color: #fff; padding: 6px; border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
    .bar button { border-radius: 999px; background: #374151; color: #fff; }
    .bar #toggle { width: 34px; height: 34px; padding: 0; font-size: 16px; }
    .bar #toggle.on { background: #3b82f6; }
    .bar #send { background: #f59e0b; color: #111; font-weight: 600; }
    .bar #send.nolisten { background: #9ca3af; }
    .bar #you { background: #ec4899; font-weight: 600; }
    .bar #stat { font-size: 12px; color: #d1d5db; padding: 0 4px 0 8px; display: flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; }
    .dot.on { background: #10b981; }
  </style>
  <div id="pins"></div>
  <div class="hl" id="hl" hidden></div>
  <div class="drag" id="drag" hidden></div>
  <div class="card" id="card" hidden></div>
  <div class="bar">
    <span id="stat"><span class="dot" id="dot"></span><span id="stattext"></span></span>
    <button id="you" hidden></button>
    <button id="send" hidden></button>
    <button id="toggle" title="Annotera (Alt+A)">✎</button>
  </div>`;
  const $ = (id) => root.getElementById(id);
  const pinsEl = $('pins'), hl = $('hl'), dragEl = $('drag'), card = $('card');

  // ---------- state ----------
  let online = false;
  let active = false;
  let items = [];
  let watcher = { project: null, listening: false };
  let down = null;      // {x, y, target}
  let dragging = false;
  let cardOpen = false;
  let cardKeys = null;  // tangenthantering för det kort som är öppet
  let suppressClick = false;
  let capturing = false;
  let lastBadge = -1;
  const verified = new Set(); // "id:verify_round" som redan fått en efter-bild härifrån

  const pageUrl = () => location.pathname + location.search;
  const isOurs = (e) => e.composedPath().includes(host);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const parse = (s, f = null) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
  const hasExt = () => { try { return !!chrome?.runtime?.id; } catch { return false; } };
  const session = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  };
  const cookie = {
    get: (name) => document.cookie.split('; ').find((c) => c.startsWith(name + '='))?.split('=')[1] ?? null,
    set: (name, v) => { document.cookie = `${name}=${v}; path=/; SameSite=Lax`; },
    del: (name) => { document.cookie = `${name}=; path=/; max-age=0`; },
  };

  // ---------- element-info ----------
  function uniqueId(el) {
    try { return el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1; } catch { return false; }
  }
  function cssPath(el) {
    if (!el || el === document.documentElement) return 'html';
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (uniqueId(el)) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let part = el.tagName.toLowerCase();
      const tid = el.getAttribute('data-testid');
      if (tid) part += `[data-testid="${tid}"]`;
      const parent = el.parentElement;
      if (parent && !tid) {
        const same = [...parent.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(' > ');
  }
  // React-komponenter: via react-probe.js i sidans värld (tillägget) eller direkt.
  function components(el) {
    if (typeof window.__annotateComponents === 'function') return window.__annotateComponents(el) || null;
    el.dispatchEvent(new CustomEvent('__annotate_probe'));
    const v = el.getAttribute('data-annotate-components');
    el.removeAttribute('data-annotate-components');
    return v || null;
  }
  function docRect(r) {
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function snippet(el) {
    const h = el.outerHTML || '';
    return h.length > 1500 ? h.slice(0, 1500) + '…' : h;
  }
  // Minsta element som innehåller hela den ritade ytan (viewport-koordinater).
  function containerFor(r) {
    host.style.display = 'none';
    let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    host.style.display = '';
    while (el && el !== document.body) {
      const b = el.getBoundingClientRect();
      if (b.left <= r.left && b.top <= r.top && b.right >= r.right && b.bottom >= r.bottom) break;
      el = el.parentElement;
    }
    return el || document.body;
  }
  function describe(el) {
    return { selector: cssPath(el), components: components(el), html: snippet(el) };
  }
  function findEl(a) {
    if (a.kind !== 'element' || !a.selector) return null;
    try { return document.querySelector(a.selector); } catch { return null; }
  }

  // ---------- skärmdumpar (kräver tillägget) ----------
  // r = dokumentkoordinater {x,y,w,h}. Tar med lite omgivning, döljer överlägget under tiden.
  async function capture(r, pad = 100) {
    if (!hasExt() || capturing || document.visibilityState !== 'visible') return null;
    capturing = true;
    const sx = scrollX, sy = scrollY;
    try {
      let x = r.x - pad, y = r.y - pad, w = r.w + 2 * pad, h = r.h + 2 * pad;
      // Scrolla in ytan om den inte syns (återställs efteråt).
      if (y < scrollY || y + Math.min(h, innerHeight) > scrollY + innerHeight) {
        scrollTo({ top: Math.max(0, y), left: sx, behavior: 'instant' });
      }
      host.style.visibility = 'hidden';
      await frame(); await frame(); await sleep(50);
      const vr = { x: Math.max(0, x - scrollX), y: Math.max(0, y - scrollY) };
      vr.w = Math.min(innerWidth - vr.x, w - Math.max(0, scrollX - x));
      vr.h = Math.min(innerHeight - vr.y, h - Math.max(0, scrollY - y));
      const res = await chrome.runtime.sendMessage({ type: 'capture', rect: vr, vw: innerWidth });
      return res?.dataUrl || null;
    } catch {
      return null; // t.ex. tillägget omladdat ("Extension context invalidated")
    } finally {
      host.style.visibility = '';
      if (scrollX !== sx || scrollY !== sy) scrollTo({ top: sy, left: sx, behavior: 'instant' });
      capturing = false;
    }
  }

  // När agenten kör `annotate verify`: ta en efter-bild av ytan i den här fliken.
  async function verify(a) {
    const token = `${a.id}:${a.verify_round}`;
    if (verified.has(token) || capturing || cardOpen || document.visibilityState !== 'visible') return;
    if (a.verify_reload && !session.get('annotate-reloaded:' + token)) {
      session.set('annotate-reloaded:' + token, '1');
      location.reload(); // appar utan HMR (t.ex. server-renderade mallar)
      return;
    }
    verified.add(token);
    await sleep(1200); // låt HMR/omladdning landa
    const el = findEl(a);
    const r = el ? docRect(el.getBoundingClientRect()) : a.rect;
    const shot = r && await capture(r);
    if (shot) await req('POST', `/annotations/${a.id}/shot`, { which: 'after', dataUrl: shot }).catch(() => verified.delete(token));
    else verified.delete(token); // försök igen vid nästa tick
  }

  // ---------- data ----------
  async function req(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }
  async function tick() {
    try {
      [items, watcher] = await Promise.all([req('GET', '/annotations'), req('GET', '/status')]);
      items.forEach((a) => { a.rect = typeof a.rect === 'string' ? parse(a.rect) : a.rect; });
      if (!online) { online = true; host.style.display = ''; }
    } catch {
      if (online) { online = false; host.style.display = 'none'; setActive(false); closeCard(); }
    }
    if (!online) return;
    render();
    for (const a of items) {
      if (a.url === pageUrl() && a.status === 'verifying') verify(a);
      if (a.status === 'done' && cookie.get(`annotate_v${a.id}`)) cookie.del(`annotate_v${a.id}`);
    }
    const waiting = items.filter((a) => NEEDS_YOU.has(a.status)).length;
    if (waiting !== lastBadge && hasExt()) {
      lastBadge = waiting;
      try { chrome.runtime.sendMessage({ type: 'badge', count: waiting }); } catch {}
    }
  }
  async function act(method, path, body) {
    try { await req(method, path, body); } catch (e) { alert('annotate: ' + e.message); }
    await tick();
  }

  // ---------- render ----------
  function pinPos(a) {
    const el = findEl(a);
    if (el) { const r = docRect(el.getBoundingClientRect()); return { x: r.x + r.w, y: r.y, rect: r }; }
    const r = a.rect || { x: 20, y: 20, w: 0, h: 0 };
    return { x: r.x + r.w, y: r.y, rect: r };
  }

  function render() {
    const mine = items.filter((a) => a.url === pageUrl());
    pinsEl.innerHTML = '';
    mine.forEach((a, i) => {
      const p = pinPos(a);
      const color = COLORS[a.status] || '#6b7280';
      if (a.kind === 'area' && a.status !== 'done') {
        const box = document.createElement('div');
        box.className = 'area';
        Object.assign(box.style, { left: p.rect.x + 'px', top: p.rect.y + 'px', width: p.rect.w + 'px', height: p.rect.h + 'px', borderColor: color });
        pinsEl.appendChild(box);
      }
      const pin = document.createElement('div');
      pin.className = 'pin ' + a.status;
      pin.textContent = a.status === 'choose' ? `${i + 1} A/B` : a.status === 'question' ? `${i + 1} ?` : i + 1;
      pin.title = `${LABELS[a.status] || a.status}: ${a.comment}`;
      Object.assign(pin.style, { left: p.x + 'px', top: p.y + 'px', background: color });
      pin.onclick = (e) => { e.stopPropagation(); showInfo(a, i + 1, p); };
      pinsEl.appendChild(pin);
    });

    const count = (pred) => items.filter(pred).length;
    const drafts = count((a) => a.status === 'draft');
    const queued = count((a) => a.status === 'open' || a.status === 'chosen');
    const busy = count((a) => BUSY.has(a.status));
    const needsYou = items.filter((a) => NEEDS_YOU.has(a.status));

    const send = $('send');
    send.hidden = drafts === 0;
    send.textContent = `Skicka (${drafts})`;
    send.classList.toggle('nolisten', !watcher.listening);
    send.title = watcher.listening ? `Skicka till ${watcher.project}` : 'Ingen Claude-session lyssnar just nu. Annoteringarna väntar tills någon gör det.';

    const you = $('you');
    you.hidden = needsYou.length === 0;
    you.textContent = `${needsYou.length} väntar på dig`;

    $('dot').classList.toggle('on', watcher.listening || busy > 0);
    const who = watcher.project || 'ingen session';
    const parts = [busy ? `${who} arbetar (${busy})` : watcher.listening ? `→ ${who}` : 'ingen lyssnar'];
    if (queued) parts.push(`${queued} i kö`);
    $('stattext').textContent = parts.join(' · ');
  }

  // Hoppa till nästa sak som väntar på användaren (byter sida om det behövs).
  $('you').onclick = () => {
    const next = items.find((a) => NEEDS_YOU.has(a.status) && a.url === pageUrl()) || items.find((a) => NEEDS_YOU.has(a.status));
    if (!next) return;
    if (next.url !== pageUrl()) { location.href = next.url; return; }
    const mine = items.filter((a) => a.url === pageUrl());
    const p = pinPos(next);
    scrollTo({ top: Math.max(0, p.y - 120), behavior: 'smooth' });
    showInfo(next, mine.indexOf(next) + 1, p);
  };

  // ---------- kort ----------
  function placeCard(x, y) {
    card.hidden = false;
    cardOpen = true;
    const left = Math.min(x + 14, scrollX + innerWidth - 356);
    const top = Math.min(y + 14, scrollY + innerHeight - card.offsetHeight - 16);
    card.style.left = Math.max(scrollX + 8, left) + 'px';
    card.style.top = Math.max(scrollY + 8, top) + 'px';
  }
  function closeCard() { card.hidden = true; cardOpen = false; card.innerHTML = ''; cardKeys = null; }

  function openComposer(draft, before) {
    const label = draft.components ? draft.components.split(' < ')[0] : draft.selector;
    let want = 1;
    card.innerHTML = `
      <div class="meta" title="${esc(draft.components || draft.selector)}">${draft.kind === 'area' ? 'Yta i' : 'Element'} · <code>${esc(label)}</code></div>
      <textarea placeholder="Här vill jag ha…"></textarea>
      <div class="row">
        <span class="hint">Varianter</span>
        <span class="seg" id="want"><button class="on" data-n="1">1</button><button data-n="2">2</button><button data-n="3">3</button></span>
      </div>
      <div class="row"><span class="hint">⌘↵ spara</span><button id="cancel">Avbryt</button><button class="primary" id="save">Spara</button></div>`;
    placeCard(draft.rect.x + draft.rect.w, draft.rect.y);
    const ta = card.querySelector('textarea');
    ta.focus();
    card.querySelectorAll('#want button').forEach((b) => {
      b.onclick = () => {
        want = Number(b.dataset.n);
        card.querySelectorAll('#want button').forEach((x) => x.classList.toggle('on', x === b));
        ta.focus();
      };
    });
    const save = async () => {
      const comment = ta.value.trim();
      if (!comment) return;
      closeCard();
      try {
        const { id } = await req('POST', '/annotations', { ...draft, comment, want_variants: want });
        if (before) await req('POST', `/annotations/${id}/shot`, { which: 'before', dataUrl: before });
      } catch (e) { alert('annotate: ' + e.message); }
      await tick();
    };
    card.querySelector('#save').onclick = save;
    card.querySelector('#cancel').onclick = closeCard;
    cardKeys = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') closeCard();
    };
  }

  // Skärmdump från servern (hämtas med fetch så att origin-kontrollen gäller).
  async function loadShot(img, id, which) {
    try {
      const res = await fetch(`${API}/annotations/${id}/shot/${which}`);
      if (res.ok) img.src = URL.createObjectURL(await res.blob());
    } catch {}
  }

  function showInfo(a, n, p) {
    const editable = a.status === 'draft';
    const thread = parse(a.thread, []);
    const variants = parse(a.variants, []);
    const current = cookie.get(`annotate_v${a.id}`) || 'A';
    const shots = [a.has_after && 'after', a.has_before && 'before'].filter(Boolean);

    card.innerHTML = `
      <div class="meta">#${n} · ${LABELS[a.status] || a.status}${a.project ? ' · ' + esc(a.project) : ''} · id ${a.id}</div>
      ${editable ? `<textarea>${esc(a.comment)}</textarea>` : `<div class="comment">${esc(a.comment)}</div>`}
      ${thread.map((t) => `<div class="bubble ${t.from}">${esc(t.text)}</div>`).join('')}
      ${a.status === 'question' ? '<textarea id="answer" placeholder="Ditt svar…"></textarea>' : ''}
      ${a.status === 'choose' ? `<div class="variants">${variants.map((v) =>
        `<button class="variant ${v.key === current ? 'on' : ''}" data-k="${esc(v.key)}"><b>${esc(v.key)}</b>${esc(v.label)}</button>`).join('')}</div>` : ''}
      ${a.reply ? `<div class="reply">${esc(a.reply)}</div>` : ''}
      ${shots.length ? `<div class="shot"><div class="tabs">${shots.map((s, i) =>
        `<button data-s="${s}" class="${i === 0 ? 'on' : ''}">${s === 'after' ? 'Efter' : 'Före'}</button>`).join('')}</div><img></div>` : ''}
      <div class="row">
        ${a.status === 'question' ? '<span class="hint">⌘↵ svara</span>' : ''}
        <button class="danger" id="del">Ta bort</button>
        ${a.status === 'done' ? '<button id="reopen">Öppna igen</button>' : ''}
        <button id="close">Stäng</button>
        ${editable ? '<button class="primary" id="upd">Spara</button>' : ''}
        ${a.status === 'question' ? '<button class="pink" id="reply">Svara</button>' : ''}
        ${a.status === 'choose' ? `<button class="pink" id="pick">Välj ${esc(current)}</button>` : ''}
      </div>`;
    placeCard(p.x, p.y);

    card.querySelector('#close').onclick = closeCard;
    card.querySelector('#del').onclick = async () => {
      if (!confirm('Ta bort annoteringen?')) return;
      closeCard();
      await act('DELETE', '/annotations/' + a.id);
    };
    const reopen = card.querySelector('#reopen');
    if (reopen) reopen.onclick = async () => { closeCard(); await act('POST', `/annotations/${a.id}/reopen`); };

    const img = card.querySelector('.shot img');
    if (img) {
      loadShot(img, a.id, shots[0]);
      card.querySelectorAll('.shot .tabs button').forEach((b) => {
        b.onclick = () => {
          card.querySelectorAll('.shot .tabs button').forEach((x) => x.classList.toggle('on', x === b));
          loadShot(img, a.id, b.dataset.s);
        };
      });
    }

    // Varianter: byt genom att sätta cookien och ladda om, välj med knappen.
    card.querySelectorAll('.variant').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.k === current) return;
        cookie.set(`annotate_v${a.id}`, b.dataset.k);
        session.set('annotate-open', String(a.id)); // öppna kortet igen efter omladdning
        location.reload();
      };
    });
    const pick = card.querySelector('#pick');
    if (pick) pick.onclick = async () => { closeCard(); await act('POST', `/annotations/${a.id}/choose`, { choice: current }); };

    const answer = card.querySelector('#answer');
    const reply = card.querySelector('#reply');
    if (answer) {
      answer.focus();
      reply.onclick = async () => {
        const text = answer.value.trim();
        if (!text) return;
        closeCard();
        await act('POST', `/annotations/${a.id}/answer`, { text });
      };
    }

    const ta = card.querySelector('textarea:not(#answer)');
    const upd = card.querySelector('#upd');
    if (upd) upd.onclick = async () => {
      const comment = ta.value.trim();
      closeCard();
      if (comment) await act('PATCH', '/annotations/' + a.id, { comment });
    };
    cardKeys = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        (reply || upd)?.click();
      }
      if (e.key === 'Escape') closeCard();
    };
  }

  // ---------- interaktion ----------
  function setActive(on) {
    active = on;
    $('toggle').classList.toggle('on', on);
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) { hl.hidden = true; dragEl.hidden = true; down = null; dragging = false; }
  }
  $('toggle').onclick = () => setActive(!active);
  $('send').onclick = () => act('POST', '/annotations/submit');

  function showBox(el, r) {
    el.hidden = false;
    Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }
  const dragRect = (e) => {
    const left = Math.min(down.x, e.clientX), top = Math.min(down.y, e.clientY);
    const width = Math.abs(e.clientX - down.x), height = Math.abs(e.clientY - down.y);
    return { left, top, width, height, right: left + width, bottom: top + height };
  };

  addEventListener('pointermove', (e) => {
    if (!active || isOurs(e) || cardOpen || capturing) return;
    if (down) {
      if (!dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { dragging = true; hl.hidden = true; }
      if (dragging) showBox(dragEl, dragRect(e));
      return;
    }
    if (e.target instanceof Element) showBox(hl, e.target.getBoundingClientRect());
  }, true);

  addEventListener('pointerdown', (e) => {
    if (!active || isOurs(e)) return;
    if (cardOpen) { closeCard(); e.preventDefault(); e.stopPropagation(); suppressClick = true; return; }
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    down = { x: e.clientX, y: e.clientY, target: e.target };
    dragging = false;
  }, true);

  addEventListener('pointerup', async (e) => {
    if (!active || !down) return;
    e.preventDefault(); e.stopPropagation();
    suppressClick = true;
    const base = { url: pageUrl(), viewport: { w: innerWidth, h: innerHeight } };
    let draft = null;
    if (dragging) {
      const r = dragRect(e);
      draft = { ...base, kind: 'area', rect: docRect(r), ...describe(containerFor(r)) };
    } else if (down.target instanceof Element) {
      const el = down.target;
      draft = { ...base, kind: 'element', rect: docRect(el.getBoundingClientRect()), ...describe(el) };
    }
    hl.hidden = true; dragEl.hidden = true; down = null; dragging = false;
    if (!draft) return;
    const before = await capture(draft.rect); // det användaren ser just nu
    openComposer(draft, before);
  }, true);

  // Blockera sidans egna klick/länkar medan läget är på.
  addEventListener('click', (e) => {
    if ((active || suppressClick) && !isOurs(e)) { e.preventDefault(); e.stopPropagation(); }
    suppressClick = false;
  }, true);

  // Tangenter: när ett kort är öppet, eller fokus ligger i överlägget, ser sidan
  // inga tangenthändelser alls (skrivandet i textrutan påverkas inte, det är
  // webbläsarens standardbeteende). Lyssnaren registreras av key-guard.js vid
  // document_start så att den ligger före sidans egna; utan tillägget gör vi det här.
  function onKey(e) {
    if (!online) return;
    if (cardOpen || isOurs(e)) {
      if (e.type === 'keydown') cardKeys?.(e);
      e.stopImmediatePropagation();
      return;
    }
    if (e.type !== 'keydown') return;
    if (e.altKey && e.code === 'KeyA') { e.preventDefault(); e.stopImmediatePropagation(); setActive(!active); }
    else if (e.key === 'Escape' && active) { e.stopImmediatePropagation(); setActive(false); }
  }
  window.__annotateOnKey = onKey;
  if (!window.__annotateGuard) {
    for (const type of ['keydown', 'keyup', 'keypress']) addEventListener(type, onKey, true);
  }

  // Övriga händelser från överlägget (klick, fokus, inmatning) stoppas vid gränsen,
  // efter att våra egna knappar har hanterat dem. Annars kan t.ex. en öppen dialog
  // på sidan tolka ett klick i bubblan som "klick utanför" och stänga sig.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
    'touchstart', 'touchend', 'focusin', 'focusout', 'input', 'beforeinput', 'paste', 'copy', 'cut',
    'compositionstart', 'compositionupdate', 'compositionend']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  // Fokusfällor (t.ex. Radix-dialoger) drar tillbaka fokus när det flyttas till
  // något utanför dialogen, alltså till vår textruta. Dölj den förflyttningen för sidan.
  addEventListener('focusout', (e) => {
    if (cardOpen && e.relatedTarget === host) e.stopImmediatePropagation();
  }, true);

  addEventListener('resize', () => online && render());

  // Efter ett variantbyte (omladdning): öppna samma kort igen.
  (async () => {
    await tick();
    const reopenId = session.get('annotate-open');
    if (reopenId) {
      session.set('annotate-open', '');
      const a = items.find((x) => String(x.id) === reopenId);
      if (a && a.url === pageUrl()) {
        const mine = items.filter((x) => x.url === pageUrl());
        showInfo(a, mine.indexOf(a) + 1, pinPos(a));
      }
    }
  })();
  setInterval(tick, 1500);
})();
