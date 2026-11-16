// Körs vid document_start så att lyssnarna nedan ligger först i kön för tangenthändelser.
// overlay.js (samma isolerade värld) sätter window.__annotateOnKey, som avgör om
// händelsen ska stoppas innan sidans egna kortkommandon ser den.
(() => {
  window.__annotateGuard = true;
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type, (e) => window.__annotateOnKey?.(e), true);
  }
})();
