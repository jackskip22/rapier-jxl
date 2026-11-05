// SPDX-License-Identifier: MIT
// In a browser: each file in files/manifest.json decoded natively two ways, drawn to a 2D canvas and read back:
//  - bitmap: createImageBitmap(blob, {premultiplyAlpha: 'none', colorSpaceConversion: 'none'}): the verdict (M15's rule);
//  - img: an <img> element, as a page shows it (the browser's color management applies): reported beside it.
// Kinds: exact (= source pixels), maxError (within the bound), lossy (within the tolerance of djxl 0.12.0's decode), masked
// (M15: alpha = source everywhere; RGB = source where the exact map is 255 and alpha 255; every other pixel within 2 of
// djxl's decode). Alpha is always exact; where 0 < alpha < 255 color also allows the premultiplied canvas's rounding.
const fetchBytes = async url => new Uint8Array(await new Response((await fetch(url + '.gz.bin')).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
async function pixels(m, path) {
  const blob = await (await fetch(`files/${m.id}.jxl`)).blob();
  let source;
  if (path === 'bitmap') source = await createImageBitmap(blob, {premultiplyAlpha: 'none', colorSpaceConversion: 'none'});
  else { source = new Image(); source.src = URL.createObjectURL(blob); await source.decode(); }
  const w = source.naturalWidth ?? source.width, h = source.naturalHeight ?? source.height;
  if (w !== m.width || h !== m.height) throw new Error(`${path} size ${w}x${h}, expected ${m.width}x${m.height}`);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', {colorSpace: 'srgb', willReadFrequently: true});
  g.drawImage(source, 0, 0);
  return g.getImageData(0, 0, w, h).data;
}
function compare(m, got, ref, map, djxl) {
  let worst = 0, alphaWorst = 0, over = 0, exactWrong = 0;
  for (let i = 0; i < ref.length; i += 4) {
    const a = ref[i + 3], b = got[i + 3];
    alphaWorst = Math.max(alphaWorst, Math.abs(a - b));
    if (!a && !b) continue;
    const premul = a < 255 ? Math.ceil(255 / Math.max(a, 1)) : 0;
    let w = 0;
    if (m.kind === 'masked') {
      const exact = map[i] === 255 && a === 255, base = exact ? ref : djxl;
      for (let k = 0; k < 3; k++) w = Math.max(w, Math.abs(base[i + k] - got[i + k]));
      if (exact && w) exactWrong++; else if (!exact && w > 2 + premul) over++;
    } else {
      for (let k = 0; k < 3; k++) w = Math.max(w, Math.abs(ref[i + k] - got[i + k]));
      if (w > m.tolerance + premul) over++;
    }
    worst = Math.max(worst, w);
  }
  return {worst, alphaWorst, over, exactWrong, pass: !over && !exactWrong && alphaWorst === 0};
}
const results = [];
for (const m of (await (await fetch('files/manifest.json')).json())) {
  const r = {id: m.id, kind: m.kind, tolerance: m.tolerance};
  try {
    const ref = await fetchBytes(`files/${m.id}.rgba`);
    const map = m.kind === 'masked' ? await fetchBytes(`files/${m.id}.map.rgba`) : null, djxl = m.kind === 'masked' ? await fetchBytes(`files/${m.id}.djxl.rgba`) : null;
    for (const path of ['bitmap', 'img']) {
      try { r[path] = compare(m, await pixels(m, path), ref, map, djxl); } catch (e) { r[path] = {pass: false, error: String(e?.message || e)}; }
    }
    r.verdict = r.bitmap.pass ? 'pass' : 'FAIL';
  } catch (e) { r.verdict = 'FAIL'; r.error = String(e?.message || e); }
  results.push(r);
}
// Native JPEG XL: any file's <img> decoded.
window.__result = {done: true, at: 'done', userAgent: navigator.userAgent, nativeJXL: results.some(r => r.img && !r.img.error), results};
document.getElementById('state').textContent = 'done';
