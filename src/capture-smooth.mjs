// SPDX-License-Identifier: MIT
export function captureSmoothRegions(data, width, height, exactRects) {
  const exact = new Uint8Array(width * height);
  for (const r of exactRects) {
    if (r.edge && r.width * r.height * 2 >= width * height) continue;
    const x0 = Math.max(0, r.x), x1 = Math.min(width, r.x + r.width), y0 = Math.max(0, r.y), y1 = Math.min(height, r.y + r.height);
    for (let y = y0; y < y1; y++) exact.fill(1, y * width + x0, y * width + x1);
  }
  const cw = Math.ceil(width / 16), ch = Math.ceil(height / 16), grid = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    const x0 = cx * 16, y0 = cy * 16, x1 = Math.min(width, x0 + 16), y1 = Math.min(height, y0 + 16), seen = new Set();
    for (let y = y0; y < y1 && seen.size < 3; y += 2) for (let x = x0; x < x1 && seen.size < 3; x += 2) {
      const p = y * width + x, i = p * 4;
      if (!exact[p] && data[i + 3] === 255) seen.add(data[i] | data[i + 1] << 8 | data[i + 2] << 16);
    }
    if (seen.size < 3) continue;
    seen.clear();
    let smooth = 0, sharp = 0, samples = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = y * width + x, i = p * 4;
      if (exact[p] || data[i + 3] !== 255) continue;
      samples++; if (seen.size < 20) seen.add(data[i] | data[i + 1] << 8 | data[i + 2] << 16);
      for (let axis = 0; axis < 2; axis++) {
        const delta = axis ? y + 1 < y1 ? width : 0 : x + 1 < x1 ? 1 : 0;
        if (!delta || exact[p + delta]) continue;
        const j = i + delta * 4, d = Math.max(Math.abs(data[i] - data[j]), Math.abs(data[i + 1] - data[j + 1]), Math.abs(data[i + 2] - data[j + 2]));
        if (d >= 1 && d <= 16) smooth++; else if (d > 24) sharp++;
      }
    }
    if (samples >= 64 && (seen.size >= 20 && smooth >= 14 || seen.size >= 3 && smooth >= 16 && sharp <= 8)) grid[cy * cw + cx] = 1;
  }
  const closed = grid.slice();
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (closed[y * cw + x]) continue;
    if (x && grid[y * cw + x - 1] && (x + 1 < cw && grid[y * cw + x + 1] || x + 2 < cw && grid[y * cw + x + 2]) ||
        y && grid[(y - 1) * cw + x] && (y + 1 < ch && grid[(y + 1) * cw + x] || y + 2 < ch && grid[(y + 2) * cw + x])) closed[y * cw + x] = 1;
  }
  const outside = new Uint8Array(closed.length), pending = [];
  const open = i => { if (outside[i] || closed[i]) return; outside[i] = 1; pending.push(i); };
  for (let x = 0; x < cw; x++) { open(x); open((ch - 1) * cw + x); }
  for (let y = 0; y < ch; y++) { open(y * cw); open(y * cw + cw - 1); }
  while (pending.length) {
    const at = pending.pop(), x = at % cw, y = at / cw | 0;
    if (x) open(at - 1); if (x + 1 < cw) open(at + 1); if (y) open(at - cw); if (y + 1 < ch) open(at + cw);
  }
  for (let i = 0; i < closed.length; i++) if (!outside[i]) closed[i] = 1;
  const seen = new Uint8Array(grid.length), regions = [];
  for (let first = 0; first < closed.length; first++) {
    if (!closed[first] || seen[first]) continue;
    const todo = [first]; seen[first] = 1;
    let x0 = first % cw, x1 = x0, y0 = first / cw | 0, y1 = y0, cells = 0;
    while (todo.length) {
      const at = todo.pop(), x = at % cw, y = at / cw | 0; cells++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, next = yy * cw + xx;
        if (xx >= 0 && xx < cw && yy >= 0 && yy < ch && closed[next] && !seen[next]) { seen[next] = 1; todo.push(next); }
      }
    }
    const columns = x1 - x0 + 1, rows = y1 - y0 + 1;
    if (Math.min(columns, rows) < 3 || Math.max(columns, rows) < 4 || cells < 12 || cells * 2 < columns * rows) continue;
    if (columns * 4 >= cw * 3 && rows * 4 >= ch * 3) { regions.push({x: 0, y: 0, width, height}); continue; }
    const x = Math.max(0, (x0 - 1) * 16), y = Math.max(0, (y0 - 1) * 16);
    const region = {x, y, width: Math.min(width, (x1 + 2) * 16) - x, height: Math.min(height, (y1 + 2) * 16) - y};
    if (Math.min(region.width, region.height) < 80) continue;
    regions.push(region);
  }
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i], b = regions[j];
    if (a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height) continue;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    regions[i] = {x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y};
    regions.splice(j, 1); i = -1; break;
  }
  return regions;
}
