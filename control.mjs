// SPDX-License-Identifier: MIT
// Capture diagnosis control: plain canvas reads before any rapier-jxl call.
// Split: bare getContext('2d') vs getContext('2d', {colorSpace:'srgb', willReadFrequently:true})
// — check.mjs (decode 47/47 on the same runner) uses willReadFrequently; prior control did not.
// Also records visibilityState / hasFocus, and a toDataURL probe on the WRF canvas.
// Heartbeat: window.__result updates after every step; done:true when finished.
const steps = [];
const pkg = document.documentElement.dataset.pkg;
const {capture} = await import('rapier-jxl');
const {decode} = await import('rapier-jxl/decode');
// A capture is right when it decodes to the painted picture (pixel 0,0 is rgb(200,100,50)); a blank read encodes to ~26 B.
const painted = async b => { const d = (await decode(b)).data; return d[0] === 200 && d[1] === 100 && d[2] === 50 && d[3] === 255; };
const platform = {
  context2dAttributes: typeof CanvasRenderingContext2D.prototype.getContextAttributes,
  webgl2: !!document.createElement('canvas').getContext('webgl2'),
  offscreen: typeof OffscreenCanvas,
  gpu: !!navigator.gpu,
  visibilityState: document.visibilityState,
  hasFocus: document.hasFocus?.() ?? null,
};
const beat = (at) => {
  window.__result = {done: false, at, pkg, userAgent: navigator.userAgent, platform, steps: steps.slice()};
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

// --- A: bare getContext('2d') ---
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

await step('bare: toDataURL', async () => {
  const url = bare.toDataURL('image/png');
  return {pass: typeof url === 'string' && url.startsWith('data:image/png') && url.length > 200, bytes: url.length};
});
// The caller's canvas as a page hands it over: opened with plain getContext('2d'), drawn, then capture(canvas).
// getContext options are sticky, so capture's own getContext('2d', {willReadFrequently: true}) returns this bare context.
await step('bare: capture(canvas)', async () => {
  const b = await capture(bare);
  return {pass: await painted(b), bytes: b.length};
});
// The copy route: the same bare canvas drawn onto a fresh willReadFrequently canvas, then read and captured there.
const copy = document.createElement('canvas');
copy.width = bare.width; copy.height = bare.height;
const gCopy = copy.getContext('2d', {colorSpace: 'srgb', willReadFrequently: true});
await step('bare→wrf copy: drawImage', async () => { gCopy.drawImage(bare, 0, 0); return {pass: true}; });
await step('bare→wrf copy: getImageData', async () => {
  const d = gCopy.getImageData(0, 0, copy.width, copy.height).data;
  return {pass: d.length === copy.width * copy.height * 4 && d[0] === 200 && d[3] === 255, bytes: d.length, first: Array.from(d.slice(0, 4)).join(',')};
});
await step('bare→wrf copy: capture(copy)', async () => {
  const b = await capture(copy);
  return {pass: await painted(b), bytes: b.length};
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

window.__result = {done: true, at: 'done', pkg, userAgent: navigator.userAgent, platform, steps};
document.getElementById('state').textContent = 'done';
