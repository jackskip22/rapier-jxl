// Rapier's JPEG XL encoder: reading a JPEG's coefficients. MIT (LICENSE).
// A JPEG is not decoded to pixels here: its quantised DCT coefficients are recovered from the Huffman-coded scans
// (baseline, extended sequential and progressive, 8-bit, grey or three components) so they can be carried into a
// JPEG XL frame as they are. Anything else (arithmetic coding, 12-bit, lossless, hierarchical, four components, a
// height left to a DNL marker) is refused with JXL_JPEG and the picture takes the ordinary path instead.

export const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

export function jpegError(message) { return Object.assign(new Error('JPEG: ' + message), {code: 'JXL_JPEG'}); }

// A 16-bit lookup: entry = (code length << 8) | symbol, 0 for no code.
function buildHuffman(counts, symbols) {
  const lookup = new Uint16Array(65536);
  let code = 0, k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      const symbol = symbols[k++], start = code << (16 - length), n = 1 << (16 - length);
      if (start + n > 65536) throw jpegError('bad Huffman table');
      lookup.fill((length << 8) | symbol, start, start + n);
      code++;
    }
    code <<= 1;
  }
  return lookup;
}

export function parseJPEG(bytes) {
  if (!(bytes.length > 4) || bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw jpegError('not a JPEG');
  const quant = [], huffman = [[], []];
  let frame = null, restartInterval = 0, adobeTransform = -1, jfif = false, orientation = 1, pos = 2;
  const u16 = at => (bytes[at] << 8) | bytes[at + 1];
  for (;;) {
    if (pos >= bytes.length) { if (frame && frame.scans) break; throw jpegError('truncated'); }
    if (bytes[pos] !== 0xFF) throw jpegError('marker expected');
    while (bytes[pos] === 0xFF) pos++;
    const marker = bytes[pos++];
    if (marker === 0xD9) break;
    if (marker === 0xD8) throw jpegError('a second start');
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) continue;
    if (pos + 2 > bytes.length) throw jpegError('truncated');
    const length = u16(pos), segment = pos + 2, end = pos + length;
    if (length < 2 || end > bytes.length) throw jpegError('bad segment');
    pos = end;
    if (marker === 0xDB) {
      for (let at = segment; at < end;) {
        const pq = bytes[at] >> 4, tq = bytes[at] & 15;
        if (pq > 1 || tq > 3) throw jpegError('bad quantisation table');
        at++;
        const table = new Int32Array(64);
        for (let k = 0; k < 64; k++) { table[ZIGZAG[k]] = pq ? u16(at) : bytes[at]; at += pq ? 2 : 1; }
        quant[tq] = table;
      }
    } else if (marker === 0xC4) {
      for (let at = segment; at < end;) {
        const tc = bytes[at] >> 4, th = bytes[at] & 15;
        if (tc > 1 || th > 3) throw jpegError('bad Huffman table');
        at++;
        const counts = bytes.subarray(at, at + 16);
        let total = 0;
        for (const c of counts) total += c;
        huffman[tc][th] = buildHuffman(counts, bytes.subarray(at + 16, at + 16 + total));
        at += 16 + total;
      }
    } else if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      if (frame) throw jpegError('two frames');
      if (bytes[segment] !== 8) throw jpegError('only 8-bit samples');
      const height = u16(segment + 1), width = u16(segment + 3), count = bytes[segment + 5];
      if (!width || !height) throw jpegError('a height left to a DNL marker');
      if (count !== 1 && count !== 3) throw jpegError('only grey or three components');
      const components = [];
      for (let i = 0, at = segment + 6; i < count; i++, at += 3) {
        const h = bytes[at + 1] >> 4, v = bytes[at + 1] & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4) throw jpegError('bad sampling');
        components.push({id: bytes[at], h, v, tq: bytes[at + 2], pred: 0});
      }
      const hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v));
      const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));
      for (const c of components) {
        c.blocksW = Math.ceil(Math.ceil(width * c.h / hmax) / 8); c.blocksH = Math.ceil(Math.ceil(height * c.v / vmax) / 8);
        c.stride = mcusX * c.h; c.rows = mcusY * c.v;
        c.coeffs = new Int16Array(c.stride * c.rows * 64);
      }
      frame = {progressive: marker === 0xC2, width, height, components, hmax, vmax, mcusX, mcusY, scans: 0};
    } else if (marker === 0xC3 || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
      throw jpegError('lossless, hierarchical or arithmetic coding');
    } else if (marker === 0xDD) restartInterval = u16(segment);
    else if (marker === 0xDC) throw jpegError('a DNL marker');
    else if (marker === 0xDA) {
      if (!frame) throw jpegError('a scan before the frame');
      const n = bytes[segment], scan = [];
      let at = segment + 1;
      for (let i = 0; i < n; i++, at += 2) {
        const component = frame.components.find(c => c.id === bytes[at]);
        if (!component) throw jpegError('a scan of an unknown component');
        scan.push({component, dc: huffman[0][bytes[at + 1] >> 4], ac: huffman[1][bytes[at + 1] & 15]});
      }
      const ss = bytes[at], se = bytes[at + 1], ah = bytes[at + 2] >> 4, al = bytes[at + 2] & 15;
      pos = decodeScan(bytes, end, frame, scan, ss, se, ah, al, restartInterval);
      frame.scans++;
    } else if (marker === 0xE0) {
      if (bytes[segment] === 0x4A && bytes[segment + 1] === 0x46 && bytes[segment + 2] === 0x49 && bytes[segment + 3] === 0x46) jfif = true;
    } else if (marker === 0xE1) {
      if (orientation === 1 && bytes[segment] === 0x45 && bytes[segment + 1] === 0x78 && bytes[segment + 2] === 0x69 && bytes[segment + 3] === 0x66) orientation = exifOrientation(bytes, segment + 6, end);
    } else if (marker === 0xEE) {
      if (length >= 14 && bytes[segment] === 0x41 && bytes[segment + 1] === 0x64 && bytes[segment + 2] === 0x6F && bytes[segment + 3] === 0x62 && bytes[segment + 4] === 0x65) adobeTransform = bytes[segment + 11];
    }
  }
  if (!frame || !frame.scans) throw jpegError('no picture');
  for (const c of frame.components) { if (!quant[c.tq]) throw jpegError('a component without its quantisation table'); c.quant = quant[c.tq]; }
  // Colour as libjxl reads it: JFIF means YCbCr; else an Adobe marker decides; else component ids spelling RGB.
  let rgb = false;
  if (frame.components.length === 3 && !jfif) {
    if (adobeTransform >= 0) rgb = adobeTransform === 0;
    else rgb = frame.components[0].id === 0x52 && frame.components[1].id === 0x47 && frame.components[2].id === 0x42;
  }
  return {width: frame.width, height: frame.height, components: frame.components, progressive: frame.progressive, ycbcr: !rgb, orientation};
}

// The Exif orientation tag (0x0112) of the first image directory, 1 when absent or unreadable.
function exifOrientation(bytes, start, end) {
  const big = bytes[start] === 0x4D && bytes[start + 1] === 0x4D;
  if (!big && !(bytes[start] === 0x49 && bytes[start + 1] === 0x49)) return 1;
  const u16 = at => at + 2 > end ? 0 : big ? (bytes[at] << 8) | bytes[at + 1] : bytes[at] | (bytes[at + 1] << 8);
  const u32 = at => at + 4 > end ? 0 : big ? ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0 : (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  if (u16(start + 2) !== 42) return 1;
  const ifd = start + u32(start + 4), entries = u16(ifd);
  for (let i = 0, at = ifd + 2; i < entries && at + 12 <= end; i++, at += 12) {
    if (u16(at) !== 0x0112) continue;
    const value = u16(at + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

function decodeScan(bytes, start, frame, scan, ss, se, ah, al, restartInterval) {
  let pos = start, buffer = 0, count = 0, marker = false;
  const fill = () => {
    while (count <= 24) {
      let byte = 0;
      if (!marker) {
        if (pos >= bytes.length) marker = true;
        else {
          byte = bytes[pos];
          if (byte === 0xFF) {
            const next = bytes[pos + 1];
            if (next === 0) pos += 2;
            else if (next === 0xFF) { pos++; continue; }
            else { marker = true; byte = 0; }
          } else pos++;
        }
      }
      buffer = ((buffer << 8) | byte) >>> 0; count += 8;
    }
  };
  const receive = n => { if (!n) return 0; fill(); const value = (buffer >>> (count - n)) & ((1 << n) - 1); count -= n; return value; };
  const extend = (value, n) => value < (1 << (n - 1)) ? value - (1 << n) + 1 : value;
  const decode = table => {
    if (!table) throw jpegError('a scan without its Huffman table');
    fill();
    const entry = table[(buffer >>> (count - 16)) & 0xFFFF];
    if (!entry) throw jpegError('bad Huffman code');
    count -= entry >> 8;
    return entry & 255;
  };
  const restart = () => {
    buffer = 0; count = 0; marker = false;
    while (pos < bytes.length && !(bytes[pos] === 0xFF && bytes[pos + 1] >= 0xD0 && bytes[pos + 1] <= 0xD7)) pos++;
    if (pos >= bytes.length) throw jpegError('a restart marker missing');
    pos += 2;
    for (const s of scan) s.component.pred = 0;
    eobrun = 0;
  };
  let eobrun = 0;
  const single = scan.length === 1, progressive = frame.progressive;
  const baseline = (s, coeffs, at) => {
    const t = decode(s.dc), diff = t ? extend(receive(t), t) : 0;
    s.component.pred += diff;
    coeffs[at] = s.component.pred;
    for (let k = 1; k < 64;) {
      const rs = decode(s.ac), r = rs >> 4, size = rs & 15;
      if (!size) { if (r === 15) { k += 16; continue; } break; }
      k += r;
      if (k > 63) throw jpegError('coefficients past the block');
      coeffs[at + ZIGZAG[k]] = extend(receive(size), size);
      k++;
    }
  };
  const dcFirst = (s, coeffs, at) => {
    const t = decode(s.dc), diff = t ? extend(receive(t), t) : 0;
    s.component.pred += diff;
    coeffs[at] = s.component.pred << al;
  };
  const dcRefine = (s, coeffs, at) => { if (receive(1)) coeffs[at] |= 1 << al; };
  const acFirst = (s, coeffs, at) => {
    if (eobrun > 0) { eobrun--; return; }
    for (let k = ss; k <= se;) {
      const rs = decode(s.ac), r = rs >> 4, size = rs & 15;
      if (!size) {
        if (r < 15) { eobrun = (1 << r) - 1 + (r ? receive(r) : 0); break; }
        k += 16; continue;
      }
      k += r;
      if (k > 63) throw jpegError('coefficients past the block');
      coeffs[at + ZIGZAG[k]] = extend(receive(size), size) * (1 << al);
      k++;
    }
  };
  const acRefine = (s, coeffs, at) => {
    const p1 = 1 << al, m1 = -1 << al;
    let k = ss;
    if (eobrun <= 0) {
      for (; k <= se; k++) {
        const rs = decode(s.ac);
        let r = rs >> 4, value = 0;
        const size = rs & 15;
        if (size) { if (size !== 1) throw jpegError('a bad refinement code'); value = receive(1) ? p1 : m1; }
        else if (r !== 15) { eobrun = 1 << r; if (r) eobrun += receive(r); break; }
        for (; k <= se; k++) {
          const z = at + ZIGZAG[k];
          if (coeffs[z] !== 0) { if (receive(1) && (coeffs[z] & p1) === 0) coeffs[z] += coeffs[z] >= 0 ? p1 : m1; }
          else if (--r < 0) break;
        }
        if (value && k <= se) coeffs[at + ZIGZAG[k]] = value;
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) {
        const z = at + ZIGZAG[k];
        if (coeffs[z] !== 0 && receive(1) && (coeffs[z] & p1) === 0) coeffs[z] += coeffs[z] >= 0 ? p1 : m1;
      }
      eobrun--;
    }
  };
  const block = !progressive ? baseline : ss === 0 ? (ah === 0 ? dcFirst : dcRefine) : (ah === 0 ? acFirst : acRefine);
  if (progressive && ss > 0 && !single) throw jpegError('an interleaved AC scan');
  if (progressive && (se > 63 || ss > se)) throw jpegError('a bad spectral selection');
  for (const s of scan) s.component.pred = 0;
  const first = scan[0].component;
  const total = single ? first.blocksW * first.blocksH : frame.mcusX * frame.mcusY;
  for (let unit = 0; unit < total; unit++) {
    if (restartInterval && unit > 0 && unit % restartInterval === 0) restart();
    if (single) {
      const by = (unit / first.blocksW) | 0, bx = unit - by * first.blocksW;
      block(scan[0], first.coeffs, (by * first.stride + bx) * 64);
    } else {
      const my = (unit / frame.mcusX) | 0, mx = unit - my * frame.mcusX;
      for (const s of scan) {
        const c = s.component;
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(s, c.coeffs, ((my * c.v + v) * c.stride + mx * c.h + h) * 64);
      }
    }
  }
  // Past the scan's data to the next marker.
  while (pos < bytes.length) {
    if (bytes[pos] === 0xFF && bytes[pos + 1] !== 0 && bytes[pos + 1] !== 0xFF && !(bytes[pos + 1] >= 0xD0 && bytes[pos + 1] <= 0xD7)) break;
    pos++;
  }
  return pos;
}
