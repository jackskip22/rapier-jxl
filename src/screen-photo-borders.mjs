// SPDX-License-Identifier: MIT
import {pixelKeys} from './screen-crop.mjs';

export function expandPhotoRegions(data, width, height, regions, masked = false) {
  const words = pixelKeys(data);
  const out = regions.map(r => ({x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height, ...r}));
  const free = (i, x0, y0, x1, y1) => !out.some((o, j) => j !== i && x0 < o.x1 && x1 > o.x0 && y0 < o.y1 && y1 > o.y0);
  const seenColors = new Uint32Array(8);
  const photoLine = (ax, ay, bx, by) => {
    let count = 0;
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
      const k = words[y * width + x];
      if (k >>> 24 !== 255) { if (masked) continue; return false; }
      if (count < 8) {
        let dup = false;
        for (let i = 0; i < count; i++) if (seenColors[i] === k) { dup = true; break; }
        if (!dup) {
          seenColors[count++] = k;
          if (masked && count === 8) return true;
        }
      }
    }
    return count >= 8;
  };
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    for(let x=Math.min(r.x0+31,r.x1-1);x>=r.x0;x--)if(!photoLine(x,r.y0,x,r.y1-1)){r.x0=x+1;break;}
    for(let x=Math.max(r.x1-32,r.x0);x<r.x1;x++)if(!photoLine(x,r.y0,x,r.y1-1)){r.x1=x;break;}

    while (r.x0 > Math.max(0, r.x - 31) && free(i, r.x0 - 1, r.y0, r.x1, r.y1) && photoLine(r.x0 - 1, r.y0, r.x0 - 1, r.y1 - 1)) r.x0--;
    while (r.x1 < Math.min(width, r.x + r.width + 31) && free(i, r.x0, r.y0, r.x1 + 1, r.y1) && photoLine(r.x1, r.y0, r.x1, r.y1 - 1)) r.x1++;
    for(let y=Math.min(r.y0+31,r.y1-1);y>=r.y0;y--)if(!photoLine(r.x0,y,r.x1-1,y)){r.y0=y+1;break;}
    for(let y=Math.max(r.y1-32,r.y0);y<r.y1;y++)if(!photoLine(r.x0,y,r.x1-1,y)){r.y1=y;break;}
    while (r.y0 > Math.max(0, r.y - 31) && free(i, r.x0, r.y0 - 1, r.x1, r.y1) && photoLine(r.x0, r.y0 - 1, r.x1 - 1, r.y0 - 1)) r.y0--;
    while (r.y1 < Math.min(height, r.y + r.height + 31) && free(i, r.x0, r.y0, r.x1, r.y1 + 1) && photoLine(r.x0, r.y1, r.x1 - 1, r.y1)) r.y1++;
  }
  return out.map(r => ({x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0}));
}

