// Annoteringsöverlägg för localhost-sidor.
// Laddas av Chrome-tillägget (eller som <script src="http://127.0.0.1:4747/overlay.js">).
// Syns bara när annotate-servern kör.
//   ✎ eller Alt+A  – slå på/av annoteringsläge
//   klick          – kommentera ett element
//   dra            – rita en yta och kommentera den
//   Skicka         – skickar utkasten till Claude-sessionen som lyssnar på den här porten
//   Esc            – stäng bubbla / lämna läget
(() => {
  if (window.top !== window || document.documentElement.hasAttribute('data-annotate')) return;
  document.documentElement.setAttribute('data-annotate', '');

  const API = window.__ANNOTATE_API || 'http://127.0.0.1:4747';
  const COLORS = { draft: '#3b82f6', open: '#f59e0b', working: '#8b5cf6', done: '#10b981' };
  const LABELS = { draft: 'utkast', open: 'skickad', working: 'pågår', done: 'klar' };

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
    .pin { position: absolute; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 50% 50% 50% 0;
           color: #fff; font-weight: 600; font-size: 12px; display: grid; place-items: center; cursor: pointer;
           box-shadow: 0 2px 6px rgba(0,0,0,.3); border: 2px solid #fff; transition: transform .1s; }
    .pin:hover { transform: scale(1.15); }
    .pin.done { opacity: .55; }
    .pin.working { animation: pulse 1.2s infinite; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(139,92,246,.35); } }
    .card { position: absolute; width: 300px; background: #fff; color: #111; border-radius: 10px; padding: 10px;
            box-shadow: 0 8px 30px rgba(0,0,0,.25); border: 1px solid #e5e7eb; }
    .card textarea { width: 100%; min-height: 70px; resize: vertical; border: 1px solid #d1d5db; border-radius: 6px;
                     padding: 6px 8px; outline: none; color: #111; background: #fff; }
    .card textarea:focus { border-color: #3b82f6; }
    .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; align-items: center; }
    .row .hint { margin-right: auto; color: #6b7280; font-size: 11px; }
    button { border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; background: #f3f4f6; color: #111; }
    button.primary { background: #3b82f6; color: #fff; }
    button.danger { background: #fee2e2; color: #b91c1c; }
    .meta { color: #6b7280; font-size: 11px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .reply { margin-top: 6px; padding: 6px 8px; background: #ecfdf5; border-radius: 6px; color: #065f46; white-space: pre-wrap; }
    .comment { white-space: pre-wrap; }
    .bar { position: fixed; right: 16px; bottom: 16px; display: flex; gap: 8px; align-items: center;
           background: #111827; color: #fff; padding: 6px; border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
    .bar button { border-radius: 999px; background: #374151; color: #fff; }
    .bar #toggle { width: 34px; height: 34px; padding: 0; font-size: 16px; }
    .bar #toggle.on { background: #3b82f6; }
    .bar #send { background: #f59e0b; color: #111; font-weight: 600; }
    .bar #send.nolisten { background: #9ca3af; }
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
  let suppressClick = false;

  const pageUrl = () => location.pathname + location.search;
  const isOurs = (e) => e.composedPath().includes(host);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
      items.forEach((a) => { a.rect = typeof a.rect === 'string' ? JSON.parse(a.rect || 'null') : a.rect; });
      if (!online) { online = true; host.style.display = ''; }
    } catch {
      if (online) { online = false; host.style.display = 'none'; setActive(false); closeCard(); }
    }
    if (online) render();
  }
  async function act(method, path, body) {
    try { await req(method, path, body); } catch (e) { alert('annotate: ' + e.message); }
    await tick();
  }

  // ---------- render ----------
  function pinPos(a) {
    if (a.kind === 'element' && a.selector) {
      try {
        const el = document.querySelector(a.selector);
        if (el) { const r = docRect(el.getBoundingClientRect()); return { x: r.x + r.w, y: r.y, rect: r }; }
      } catch {}
    }
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
      pin.textContent = i + 1;
      pin.title = `${LABELS[a.status]}: ${a.comment}`;
      Object.assign(pin.style, { left: p.x + 'px', top: p.y + 'px', background: color });
      pin.onclick = (e) => { e.stopPropagation(); showInfo(a, i + 1, p); };
      pinsEl.appendChild(pin);
    });

    const count = (s) => items.filter((a) => a.status === s).length;
    const drafts = count('draft'), open = count('open'), working = count('working');
    const send = $('send');
    send.hidden = drafts === 0;
    send.textContent = `Skicka (${drafts})`;
    send.classList.toggle('nolisten', !watcher.listening);
    send.title = watcher.listening ? `Skicka till ${watcher.project}` : 'Ingen Claude-session lyssnar just nu. Annoteringarna väntar tills någon gör det.';

    $('dot').classList.toggle('on', watcher.listening || working > 0);
    const who = watcher.project || 'ingen session';
    const parts = [working ? `${who} arbetar (${working})` : watcher.listening ? `→ ${who}` : 'ingen lyssnar'];
    if (open) parts.push(`${open} i kö`);
    $('stattext').textContent = parts.join(' · ');
  }

  // ---------- kort: ny kommentar / info ----------
  function placeCard(x, y) {
    card.hidden = false;
    cardOpen = true;
    const left = Math.min(x + 14, scrollX + innerWidth - 316);
    const top = Math.min(y + 14, scrollY + innerHeight - card.offsetHeight - 16);
    card.style.left = Math.max(scrollX + 8, left) + 'px';
    card.style.top = Math.max(scrollY + 8, top) + 'px';
  }
  let cardKeys = null; // tangenthantering för det kort som är öppet
  function closeCard() { card.hidden = true; cardOpen = false; card.innerHTML = ''; cardKeys = null; }

  function openComposer(draft) {
    const label = draft.components ? draft.components.split(' < ')[0] : draft.selector;
    card.innerHTML = `
      <div class="meta" title="${esc(draft.components || draft.selector)}">${draft.kind === 'area' ? 'Yta i' : 'Element'} · <code>${esc(label)}</code></div>
      <textarea placeholder="Här vill jag ha…"></textarea>
      <div class="row"><span class="hint">⌘↵ spara</span><button id="cancel">Avbryt</button><button class="primary" id="save">Spara</button></div>`;
    placeCard(draft.rect.x + draft.rect.w, draft.rect.y);
    const ta = card.querySelector('textarea');
    ta.focus();
    const save = async () => {
      const comment = ta.value.trim();
      if (!comment) return;
      closeCard();
      await act('POST', '/annotations', { ...draft, comment });
    };
    card.querySelector('#save').onclick = save;
    card.querySelector('#cancel').onclick = closeCard;
    cardKeys = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') closeCard();
    };
  }

  function showInfo(a, n, p) {
    const editable = a.status === 'draft';
    card.innerHTML = `
      <div class="meta">#${n} · ${LABELS[a.status]}${a.project ? ' · ' + esc(a.project) : ''} · id ${a.id}</div>
      ${editable ? `<textarea>${esc(a.comment)}</textarea>` : `<div class="comment">${esc(a.comment)}</div>`}
      ${a.reply ? `<div class="reply">${esc(a.reply)}</div>` : ''}
      <div class="row">
        <button class="danger" id="del">Ta bort</button>
        ${a.status === 'done' ? '<button id="reopen">Öppna igen</button>' : ''}
        <button id="close">Stäng</button>
        ${editable ? '<button class="primary" id="upd">Spara</button>' : ''}
      </div>`;
    placeCard(p.x, p.y);
    card.querySelector('#close').onclick = closeCard;
    card.querySelector('#del').onclick = async () => { closeCard(); await act('DELETE', '/annotations/' + a.id); };
    const reopen = card.querySelector('#reopen');
    if (reopen) reopen.onclick = async () => { closeCard(); await act('PATCH', '/annotations/' + a.id, { status: 'draft', reply: null }); };
    const ta = card.querySelector('textarea');
    const upd = card.querySelector('#upd');
    if (upd) upd.onclick = async () => {
      const comment = ta.value.trim();
      closeCard();
      if (comment) await act('PATCH', '/annotations/' + a.id, { comment });
    };
    cardKeys = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && upd) { e.preventDefault(); upd.click(); }
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
    if (!active || isOurs(e) || cardOpen) return;
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

  addEventListener('pointerup', (e) => {
    if (!active || !down) return;
    e.preventDefault(); e.stopPropagation();
    suppressClick = true;
    const base = { url: pageUrl(), viewport: { w: innerWidth, h: innerHeight } };
    if (dragging) {
      const r = dragRect(e);
      openComposer({ ...base, kind: 'area', rect: docRect(r), ...describe(containerFor(r)) });
    } else if (down.target instanceof Element) {
      const el = down.target;
      openComposer({ ...base, kind: 'element', rect: docRect(el.getBoundingClientRect()), ...describe(el) });
    }
    hl.hidden = true; dragEl.hidden = true; down = null; dragging = false;
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
  tick();
  setInterval(tick, 1500);
})();
