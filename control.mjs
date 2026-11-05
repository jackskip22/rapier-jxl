// SPDX-License-Identifier: MIT
// Capture diagnosis control: plain getImageData + createImageBitmap before any rapier-jxl call,
// then capture(canvas). Attached/visible after rAF vs detached/never-painted.
// Heartbeat: window.__result updates after every step; done:true when finished.
const steps = [];
const platform = {
  context2dAttributes: typeof CanvasRenderingContext2D.prototype.getContextAttributes,
  webgl2: !!document.createElement('canvas').getContext('webgl2'),
  offscreen: typeof OffscreenCanvas,
  gpu: !!navigator.gpu,
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

const paint = (c) => {
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4ef';
  g.fillRect(0, 0, c.width, c.height);
  // colour bars (same idea as p3) so a plain read has known non-zero pixels
  const colours = [[200, 100, 50], [40, 160, 90], [90, 80, 220], [250, 250, 250], [128, 128, 128], [230, 30, 40]];
  colours.forEach(([r, gr, b], i) => {
    g.fillStyle = `rgb(${r},${gr},${b})`;
    g.fillRect(i * 24, 0, 24, c.height);
  });
  g.fillStyle = '#123';
  g.font = '14px sans-serif';
  g.fillText('control', 8, 24);
  return g;
};

const rAF = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

beat('start');

// --- attached, visible, after rAF ---
const attached = document.createElement('canvas');
attached.width = 160;
attached.height = 100;
attached.style.cssText = 'display:block;width:160px;height:100px;';
attached.setAttribute('aria-label', 'attached control canvas');
document.getElementById('host').appendChild(attached);
const gAtt = paint(attached);
await rAF();

await step('attached: getImageData', async () => {
  const d = gAtt.getImageData(0, 0, attached.width, attached.height).data;
  return {pass: d.length === attached.width * attached.height * 4 && d[0] === 200, bytes: d.length};
});
await step('attached: createImageBitmap(canvas)', async () => {
  const bmp = await createImageBitmap(attached);
  const width = bmp.width, height = bmp.height;
  const ok = width === attached.width && height === attached.height;
  bmp.close?.();
  return {pass: ok, width, height};
});

const {capture} = await import('rapier-jxl');
await step('attached: capture(canvas) after plain reads', async () => {
  const b = await capture(attached);
  return {pass: b instanceof Uint8Array && b.length > 0, bytes: b.length};
});

// --- detached, never in document ---
const detached = document.createElement('canvas');
detached.width = 160;
detached.height = 100;
const gDet = paint(detached);
// no appendChild, no rAF paint into document

await step('detached: getImageData', async () => {
  const d = gDet.getImageData(0, 0, detached.width, detached.height).data;
  return {pass: d.length === detached.width * detached.height * 4 && d[0] === 200, bytes: d.length};
});
await step('detached: createImageBitmap(canvas)', async () => {
  const bmp = await createImageBitmap(detached);
  const width = bmp.width, height = bmp.height;
  const ok = width === detached.width && height === detached.height;
  bmp.close?.();
  return {pass: ok, width, height};
});
await step('detached: capture(canvas) after plain reads', async () => {
  const b = await capture(detached);
  return {pass: b instanceof Uint8Array && b.length > 0, bytes: b.length};
});

window.__result = {done: true, at: 'done', userAgent: navigator.userAgent, platform, steps};
document.getElementById('state').textContent = 'done';
