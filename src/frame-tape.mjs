// SPDX-License-Identifier: MIT
export class FrameTape {
  constructor(width, height, first) {
    this.width = width; this.height = height; this.bytes = width * height * 4;
    this.steps = [null]; this.checkpoints = new Map([[0, first]]); this.held = first.byteLength;
    this.since = 0; this.recent = new Map();
  }
  nextHeld(rect) {
    if (!rect) return this.held;
    const size = rect[2] * rect[3] * 4;
    return this.held + (this.since + size >= this.bytes ? this.bytes : size);
  }
  push(canvas, rect) {
    const k = this.steps.length;
    if (!rect) { this.steps.push(null); return this.held; }
    const [x, y, w, h] = rect, held = this.nextHeld(rect), size = held - this.held;
    if (size === this.bytes) {
      this.steps.push(null); this.checkpoints.set(k, canvas.slice()); this.held = held; this.since = 0;
      return this.held;
    }
    const pixels = new Uint8Array(size);
    for (let r = 0; r < h; r++) pixels.set(canvas.subarray(((y + r) * this.width + x) * 4, ((y + r) * this.width + x + w) * 4), r * w * 4);
    this.steps.push({rect, pixels}); this.held = held; this.since += size;
    return this.held;
  }
  get length() { return this.steps.length; }
  sameAs(k) { while (k > 0 && !this.steps[k] && !this.checkpoints.has(k)) k--; return k; }
  frameAt(k) {
    k = this.sameAs(k);
    const ready = this.checkpoints.get(k) ?? this.recent.get(k);
    if (ready) return this.keep(k, ready);
    let from = k;
    while (!this.recent.has(from) && !this.checkpoints.has(from)) from--;
    const canvas = (this.checkpoints.get(from) ?? this.recent.get(from)).slice(), {width} = this;
    for (let j = from + 1; j <= k; j++) {
      const step = this.steps[j];
      if (!step) continue;
      const {rect: [x, y, w, h], pixels} = step;
      for (let r = 0; r < h; r++) canvas.set(pixels.subarray(r * w * 4, (r + 1) * w * 4), ((y + r) * width + x) * 4);
    }
    return this.keep(k, canvas);
  }
  keep(k, canvas) {
    if (this.checkpoints.has(k)) return canvas;
    this.recent.delete(k); this.recent.set(k, canvas);
    while (this.recent.size > 2 && this.recent.size * this.bytes > this.held) this.recent.delete(this.recent.keys().next().value);
    return canvas;
  }
}
