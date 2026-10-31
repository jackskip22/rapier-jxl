// SPDX-License-Identifier: MIT
const TILE = 32, MAX_RECTS = 16, MAX_PIXELS = 8294400;
const abs = Math.abs;
const rgb = (data, at) => data[at] | data[at + 1] << 8 | data[at + 2] << 16;

export function screenPhotoRegions(data, width, height) {
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 192 || height < 128 || pixels > MAX_PIXELS ||
      data.length !== pixels * 4) return [];
  const cols = Math.floor(width / TILE), rows = Math.floor(height / TILE), tiles = cols * rows;
  const opaque = new Uint8Array(tiles), seeds = new Uint8Array(tiles);

  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    const x0 = tx * TILE, y0 = ty * TILE, index = ty * cols + tx;
    let whole = true;
    for (let y = 0; y < TILE && whole; y++) {
      let at = ((y0 + y) * width + x0) * 4 + 3;
      for (let x = 0; x < TILE; x++, at += 4) if (data[at] !== 255) { whole = false; break; }
    }
    if (!whole) continue;
    opaque[index] = 1;
    const colors = new Set(), quadrants = [new Set(), new Set(), new Set(), new Set()];
    const edges = [new Set(), new Set(), new Set(), new Set()];
    let changes = 0;
    for (let y = 0; y < TILE; y += 2) for (let x = 0; x < TILE; x += 2) {
      const at = ((y0 + y) * width + x0 + x) * 4, key = rgb(data, at);
      colors.add(key);
      quadrants[(y >= 16 ? 2 : 0) + (x >= 16 ? 1 : 0)].add(key);
      const right = at + 4, down = at + width * 4;
      const horizontal = abs(data[at] - data[right]) + abs(data[at + 1] - data[right + 1]) + abs(data[at + 2] - data[right + 2]);
      const vertical = abs(data[at] - data[down]) + abs(data[at + 1] - data[down + 1]) + abs(data[at + 2] - data[down + 2]);
      if (horizontal > 30 && vertical > 30) changes++;
    }
    for (let v = 0; v < TILE; v += 2) {
      edges[0].add(rgb(data, ((y0 + 0) * width + x0 + v) * 4));
      edges[1].add(rgb(data, ((y0 + TILE - 1) * width + x0 + v) * 4));
      edges[2].add(rgb(data, ((y0 + v) * width + x0) * 4));
      edges[3].add(rgb(data, ((y0 + v) * width + x0 + TILE - 1) * 4));
    }
    if (colors.size >= 96 && changes >= 4 &&
        quadrants.every(part => part.size >= 20) &&
        edges.every(edge => edge.size >= 4)) seeds[index] = 1;
  }

  const seen = new Uint8Array(tiles), queue = new Int32Array(tiles), regions = [];
  for (let start = 0; start < tiles; start++) {
    if (!seeds[start] || seen[start]) continue;
    let front = 0, end = 1, minX = start % cols, maxX = minX;
    let minY = Math.floor(start / cols), maxY = minY;
    queue[0] = start; seen[start] = 1;
    while (front < end) {
      const tile = queue[front++], tx = tile % cols, ty = Math.floor(tile / cols);
      minX = Math.min(minX, tx); maxX = Math.max(maxX, tx);
      minY = Math.min(minY, ty); maxY = Math.max(maxY, ty);
      for (let y = Math.max(0, ty - 1); y <= Math.min(rows - 1, ty + 1); y++)
        for (let x = Math.max(0, tx - 1); x <= Math.min(cols - 1, tx + 1); x++) {
          const next = y * cols + x;
          if (seeds[next] && !seen[next]) { seen[next] = 1; queue[end++] = next; }
        }
    }
    const tw = maxX - minX + 1, th = maxY - minY + 1, area = tw * th;
    if (tw < 6 || th < 4 || area < 32 || end < 20 || end * 2 < area) continue;
    let safe = true;
    for (let y = minY; y <= maxY && safe; y++)
      for (let x = minX; x <= maxX; x++)
        if (!opaque[y * cols + x]) { safe = false; break; }
    if (!safe) continue;
    const region = {x: minX * TILE, y: minY * TILE, width: tw * TILE, height: th * TILE};
    if (regions.some(r => r.x < region.x + region.width && region.x < r.x + r.width &&
        r.y < region.y + region.height && region.y < r.y + r.height)) return [];
    regions.push(region);
    if (regions.length > MAX_RECTS) return [];
  }
  const covered = regions.reduce((sum, r) => sum + r.width * r.height, 0);
  if (covered < Math.max(16384, pixels * 0.04)) return [];
  return regions.sort((a, b) => a.y - b.y || a.x - b.x);
}
