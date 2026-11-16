// Körs i sidans egen JS-värld (world: MAIN) så att den når Reacts interna fiber-noder.
// overlay.js (isolerad värld) skickar ett event på elementet; svaret skrivs som attribut.
(() => {
  const IGNORE = /^(Fragment|Suspense|StrictMode|Profiler|.*(Router|Boundary|Provider|Context|Consumer|Handler|Template|Segment|Root|HotReload|DevOverlay|Portal).*)$/;

  window.__annotateComponents = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!key) return '';
    const names = [];
    for (let f = el[key]; f && names.length < 8; f = f.return) {
      const t = f.type;
      if (!t || typeof t === 'string') continue;
      const n = typeof t === 'function'
        ? t.displayName || t.name
        : t.displayName || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name;
      if (n && /^[A-Z]/.test(n) && !IGNORE.test(n) && names[names.length - 1] !== n) names.push(n);
    }
    return names.join(' < ');
  };

  document.addEventListener('__annotate_probe', (e) => {
    if (e.target instanceof Element) e.target.setAttribute('data-annotate-components', window.__annotateComponents(e.target));
  }, true);
})();
