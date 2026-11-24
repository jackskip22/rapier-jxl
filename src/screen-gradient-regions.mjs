// SPDX-License-Identifier: MIT
const TILE = 32;
const P = () => ({STEP: 3, BLOCK: 4, MIN_SMOOTH: 4, MIN_CELLS: 12});
export const GRADIENT = Symbol.for('rapier-jxl.gradient');

const CELLS = new WeakMap();
function gradientCells(data, width, height) {
  const had = CELLS.get(data);
  if (had && had.width === width && had.height === height) return had;
  const {STEP} = P();
  const cols = Math.floor(width / TILE), rows = Math.floor(height / TILE);
  const smooth = new Uint8Array(cols * rows), stride = width * 4;
  let quiet = 0;
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    let moved = 0, ok = 1;
    for (let y = ty * TILE; ok && y < ty * TILE + TILE; y++) {
      let i = (y * width + tx * TILE) * 4;
      for (let x = 0; x < TILE; x++, i += 4) {
        if (x < TILE - 1) {
          const a = data[i] - data[i + 4], b = data[i + 1] - data[i + 5], c = data[i + 2] - data[i + 6];
          if (a > STEP || a < -STEP || b > STEP || b < -STEP || c > STEP || c < -STEP) { ok = 0; break; }
          if (a | b | c) moved = 1;
        }
        if (y < ty * TILE + TILE - 1) {
          const a = data[i] - data[i + stride], b = data[i + 1] - data[i + stride + 1], c = data[i + 2] - data[i + stride + 2];
          if (a > STEP || a < -STEP || b > STEP || b < -STEP || c > STEP || c < -STEP) { ok = 0; break; }
          if (a | b | c) moved = 1;
        }
      }
    }
    quiet += ok;
    smooth[ty * cols + tx] = ok & moved;
  }
  const cells = {width, height, cols, rows, smooth, quiet};
  CELLS.set(data, cells);
  return cells;
}

export function gradientRegions(data, width, height) {
  const {BLOCK, MIN_SMOOTH, MIN_CELLS} = P();
  if (width < BLOCK * TILE || height < BLOCK * TILE) return [];
  const {cols, rows, smooth} = gradientCells(data, width, height);
  const bc = Math.ceil(cols / BLOCK), br = Math.ceil(rows / BLOCK), marked = new Uint8Array(bc * br);
  for (let by = 0; by < br; by++) for (let bx = 0; bx < bc; bx++) {
    let n = 0;
    for (let y = by * BLOCK; y < Math.min(rows, by * BLOCK + BLOCK); y++) for (let x = bx * BLOCK; x < Math.min(cols, bx * BLOCK + BLOCK); x++) n += smooth[y * cols + x];
    marked[by * bc + bx] = n >= MIN_SMOOTH ? 1 : 0;
  }
  const open = new Map(), out = [], span = BLOCK * TILE;
  for (let by = 0; by <= br; by++) {
    const now = new Map();
    if (by < br) for (let bx = 0; bx < bc; bx++) if (marked[by * bc + bx]) {
      let e = bx;
      while (e + 1 < bc && marked[by * bc + e + 1]) e++;
      const k = bx + ',' + e;
      now.set(k, open.get(k) ?? {x: bx, y: by, x1: e});
      bx = e;
    }
    for (const [k, r] of open) if (!now.has(k))
      out.push({x: r.x * span, y: r.y * span, width: Math.min(cols * TILE, (r.x1 + 1) * span) - r.x * span, height: Math.min(rows * TILE, by * span) - r.y * span});
    open.clear();
    for (const [k, r] of now) open.set(k, r);
  }
  const cellsIn = r => {
    let n = 0;
    for (let y = Math.floor(r.y / TILE); y < Math.min(rows, Math.ceil((r.y + r.height) / TILE)); y++) for (let x = Math.floor(r.x / TILE); x < Math.min(cols, Math.ceil((r.x + r.width) / TILE)); x++) n += smooth[y * cols + x];
    return n;
  };
  return out.filter(r => r.width >= 4 * TILE && r.height >= 3 * TILE && cellsIn(r) >= MIN_CELLS);
}

export function smoothPageGround(data, width, height) {
  if (!gradientRegions(data, width, height).length) return false;
  const {cols, rows, quiet} = gradientCells(data, width, height);
  return cols > 0 && rows > 0 && quiet * 2 >= cols * rows;
}

export function gradientProtectionRects(data, width, height) {
  const {cols, rows, smooth} = gradientCells(data, width, height);
  const cw = Math.ceil(width / TILE), ch = Math.ceil(height / TILE), kept = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (x < cols && y < rows && smooth[y * cols + x]) continue;
    for (let dy = Math.max(0, y - 1); dy <= Math.min(ch - 1, y + 1); dy++)
      kept.fill(1, dy * cw + Math.max(0, x - 1), dy * cw + Math.min(cw, x + 2));
  }
  const out = [], open = new Map();
  for (let y = 0; y < ch; y++) {
    const now = new Map();
    for (let x = 0; x < cw; x++) if (kept[y * cw + x]) {
      const first = x;
      while (x + 1 < cw && kept[y * cw + x + 1]) x++;
      const key = first + ',' + x, prior = open.get(key);
      if (prior) prior.height = Math.min(height, (y + 1) * TILE) - prior.y;
      else out.push({x: first * TILE, y: y * TILE, width: Math.min(width, (x + 1) * TILE) - first * TILE, height: Math.min(TILE, height - y * TILE)});
      now.set(key, prior ?? out[out.length - 1]);
    }
    open.clear();
    for (const [key, r] of now) open.set(key, r);
  }
  return out;
}
