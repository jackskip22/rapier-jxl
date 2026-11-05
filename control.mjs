// SPDX-License-Identifier: MIT
// Capture diagnosis control: plain canvas reads before any rapier-jxl call.
// Split: bare getContext('2d') vs getContext('2d', {colorSpace:'srgb', willReadFrequently:true})
// — check.mjs (decode 47/47 on the same runner) uses willReadFrequently; prior control did not.
// Also records visibilityState / hasFocus, and a toDataURL probe on the WRF canvas.
// Heartbeat: window.__result updates after every step; done:true when finished.
const steps = [];
const platform = {
  context2dAttributes: typeof CanvasRenderingContext2D.prototype.getContextAttributes,
  webgl2: !!document.createElement('canvas').getContext('webgl2'),
  offscreen: typeof OffscreenCanvas,
  gpu: !!navigator.gpu,
  visibilityState: document.visibilityState,
  hasFocus: document.hasFocus?.() ?? null,
};
const beat = (at) => {
  window.__result = {done: false, at, userAgent: navigator.userAgent, platform, steps: steps.slice()};
  document.getElementById('state').textContent = at;
};
const step = async (name, f) => {
  beat('before:' + name);
  try {
    const r = await f();
    steps.push({name, ...r});
  } catch (e) {
    steps.push({
      name,
      pass: false,
      error: String(e?.message || e).slice(0, 200),
      code: e?.code,
      stack: String(e?.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 400),
    });
  }
  beat('after:' + name);
};

const paint = (g, c) => {
  g.fillStyle = '#f4f4ef';
  g.fillRect(0, 0, c.width, c.height);
  const colours = [[200, 100, 50], [40, 160, 90], [90, 80, 220], [250, 250, 250], [128, 128, 128], [230, 30, 40]];
  colours.forEach(([r, gr, b], i) => {
    g.fillStyle = `rgb(${r},${gr},${b})`;
    g.fillRect(i * 24, 0, 24, c.height);
  });
  g.fillStyle = '#123';
  g.font = '14px sans-serif';
  g.fillText('control', 8, 24);
};

const rAF = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const host = document.getElementById('host');

beat('start');

await step('page: visibility + focus', async () => {
  const visibilityState = document.visibilityState;
  const hasFocus = document.hasFocus?.() ?? null;
  platform.visibilityState = visibilityState;
  platform.hasFocus = hasFocus;
  // Not a pass/fail gate — informational for safaridriver foreground diagnosis.
  return {pass: true, visibilityState, hasFocus};
});

// --- A: bare getContext('2d') (prior control shape; failed on 41979942528) ---
const bare = document.createElement('canvas');
bare.width = 160; bare.height = 100;
bare.style.cssText = 'display:block;width:160px;height:100px;';
host.appendChild(bare);
const gBare = bare.getContext('2d');
paint(gBare, bare);
await rAF();

await step('bare: getImageData', async () => {
  const d = gBare.getImageData(0, 0, bare.width, bare.height).data;
  return {pass: d.length === bare.width * bare.height * 4 && d[0] === 200, bytes: d.length};
});
await step('bare: createImageBitmap(canvas)', async () => {
  const bmp = await createImageBitmap(bare);
  const width = bmp.width, height = bmp.height;
  bmp.close?.();
  return {pass: width === bare.width && height === bare.height, width, height};
});

// --- B: willReadFrequently (matches check.mjs decode path that passed 47/47) ---
const wrf = document.createElement('canvas');
wrf.width = 160; wrf.height = 100;
wrf.style.cssText = 'display:block;width:160px;height:100px;';
host.appendChild(wrf);
const gWrf = wrf.getContext('2d', {colorSpace: 'srgb', willReadFrequently: true});
paint(gWrf, wrf);
await rAF();

await step('wrf: getImageData', async () => {
  const d = gWrf.getImageData(0, 0, wrf.width, wrf.height).data;
  const attrs = gWrf.getContextAttributes?.() || {};
  return {
    pass: d.length === wrf.width * wrf.height * 4 && d[0] === 200,
    bytes: d.length,
    willReadFrequently: attrs.willReadFrequently ?? null,
    colorSpace: attrs.colorSpace ?? null,
  };
});
await step('wrf: createImageBitmap(canvas)', async () => {
  const bmp = await createImageBitmap(wrf);
  const width = bmp.width, height = bmp.height;
  bmp.close?.();
  return {pass: width === wrf.width && height === wrf.height, width, height};
});
await step('wrf: toDataURL', async () => {
  const url = wrf.toDataURL('image/png');
  return {pass: typeof url === 'string' && url.startsWith('data:image/png'), bytes: url.length};
});

const {capture} = await import('rapier-jxl');
await step('wrf: capture(canvas) after plain reads', async () => {
  const b = await capture(wrf);
  return {pass: b instanceof Uint8Array && b.length > 0, bytes: b.length};
});

// --- detached WRF (never in document) ---
const detached = document.createElement('canvas');
detached.width = 160; detached.height = 100;
const gDet = detached.getContext('2d', {colorSpace: 'srgb', willReadFrequently: true});
paint(gDet, detached);

await step('detached-wrf: getImageData', async () => {
  const d = gDet.getImageData(0, 0, detached.width, detached.height).data;
  return {pass: d.length === detached.width * detached.height * 4 && d[0] === 200, bytes: d.length};
});
await step('detached-wrf: createImageBitmap(canvas)', async () => {
  const bmp = await createImageBitmap(detached);
  const width = bmp.width, height = bmp.height;
  bmp.close?.();
  return {pass: width === detached.width && height === detached.height, width, height};
});
await step('detached-wrf: capture(canvas) after plain reads', async () => {
  const b = await capture(detached);
  return {pass: b instanceof Uint8Array && b.length > 0, bytes: b.length};
});

window.__result = {done: true, at: 'done', userAgent: navigator.userAgent, platform, steps};
document.getElementById('state').textContent = 'done';
