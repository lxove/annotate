// Bakgrundsprocess: skärmdumpar av den synliga fliken (bara tillägg får ta dem)
// och badge på ikonen med antal saker som väntar på användaren.
const MAX_WIDTH = 1600;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'capture') {
    capture(msg, sender.tab).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
    return true; // svarar asynkront
  }
  if (msg.type === 'badge') {
    chrome.action.setBadgeBackgroundColor({ color: '#ec4899' });
    chrome.action.setBadgeText({ text: msg.count ? String(msg.count) : '' });
  }
});

// rect är i viewport-koordinater (CSS-pixlar); vw = innerWidth i fliken.
async function capture({ rect, vw }, tab) {
  // captureVisibleTab tar den aktiva fliken i fönstret, så frågande flik måste vara den.
  const current = await chrome.tabs.get(tab.id);
  if (!current.active) return { error: 'Fliken är inte aktiv' };

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const s = bmp.width / vw; // devicePixelRatio inkl. zoom
  const sx = Math.max(0, Math.round(rect.x * s));
  const sy = Math.max(0, Math.round(rect.y * s));
  const sw = Math.min(bmp.width - sx, Math.round(rect.w * s));
  const sh = Math.min(bmp.height - sy, Math.round(rect.h * s));
  if (sw < 4 || sh < 4) return { error: 'Tom yta' };

  const scale = Math.min(1, MAX_WIDTH / sw);
  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { dataUrl: 'data:image/png;base64,' + btoa(bin) };
}
