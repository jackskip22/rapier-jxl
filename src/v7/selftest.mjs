// SPDX-License-Identifier: MIT

const hex = buffer => Array.from(new Uint8Array(buffer), n => n.toString(16).padStart(2, '0')).join('');
export const sha256 = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));

export async function readPNG(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), idat = [];
  let width = 0, height = 0, channels = 0;
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8)), body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8); height = view.getUint32(at + 12);
      const depth = body[8], color = body[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || body[12] !== 0) throw new Error('Self-test picture is not 8-bit RGB or RGBA without interlace');
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    at += 12 + length;
  }
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer()), stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error('Self-test picture has the wrong data length');
  const data = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[x] = (line[x] + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1
        : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
      data[o] = line[x * channels]; data[o + 1] = line[x * channels + 1]; data[o + 2] = line[x * channels + 2];
      data[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    previous = line;
  }
  return {data, width, height};
}

const error = e => ({name: e?.name || 'Error', code: e?.code || null, message: String(e?.message || e)});
const QUALITY = 90;

export function selftestRows(manifest) {
  const rows = [];
  for (const picture of manifest.pictures) {
    if (picture.kind === 'jpeg') {
      for (const effort of [1, 3, 7]) rows.push({id: `${picture.id}-recompress-e${effort}`, picture: picture.id, operation: 'recompress', effort});
    } else for (const fidelity of ['exact', 'lossy']) for (const effort of [1, 3, 7])
      rows.push({id: `${picture.id}-${fidelity}-e${effort}`, picture: picture.id, operation: 'encode', fidelity, effort});
  }
  return rows;
}

export async function selftest({modules, manifest, picture, facts = {}, onStep = () => {}, onRow = () => {}, now = () => performance.now()}) {
  const started = now();
  const record = {schema: 1, kind: 'rapier-jxl-selftest', version: manifest.version, status: 'running', machine: facts,
    pictures: [], rows: [], summary: null};
  const inputs = new Map();
  for (const item of manifest.pictures) {
    onStep('Read ' + item.file);
    const entry = {id: item.id, file: item.file, kind: item.kind};
    record.pictures.push(entry);
    try {
      const bytes = new Uint8Array(await picture(item.file));
      entry.bytes = bytes.length; entry.sha256 = await sha256(bytes);
      if (entry.sha256 !== item.sha256) throw new Error(`${item.file} does not match its SHA-256`);
      if (item.kind === 'jpeg') inputs.set(item.id, {bytes, sha256: entry.sha256});
      else {
        const pixels = await readPNG(bytes);
        entry.width = pixels.width; entry.height = pixels.height; entry.rgbaSha256 = await sha256(pixels.data);
        if (entry.rgbaSha256 !== item.rgbaSha256) throw new Error(`${item.file} decodes to other pixels`);
        inputs.set(item.id, {bytes, pixels, rgbaSha256: entry.rgbaSha256});
      }
    } catch (e) { entry.error = error(e); }
  }
  for (const row of selftestRows(manifest)) {
    onStep(row.id);
    const input = inputs.get(row.picture), out = {...row, status: 'fail'};
    record.rows.push(out);
    if (!input) { out.error = {name: 'Error', code: null, message: 'The picture could not be read'}; onRow(out); continue; }
    try {
      let result, t = now();
      if (row.operation === 'recompress') result = await modules.recompress(input.bytes, {effort: row.effort});
      else result = await modules.encode(input.pixels, {fidelity: row.fidelity === 'exact' ? 'exact' : {quality: QUALITY}, effort: row.effort, webgpu: false});
      out.encodeMs = now() - t;
      out.bytes = result.bytes.length; out.sha256 = await sha256(result.bytes);
      const expected = manifest.expected?.[row.id] ?? null;
      out.expectedSha256 = expected;
      out.sameBytes = expected === null ? null : out.sha256 === expected;
      if (row.operation === 'recompress') {
        t = now();
        const restored = await modules.restore(result.bytes);
        out.restoreMs = now() - t;
        out.restoredSha256 = await sha256(restored.bytes);
        out.exact = out.restoredSha256 === input.sha256;
      } else {
        t = now();
        const decoded = await modules.decode(result.bytes);
        out.decodeMs = now() - t;
        if (decoded.width !== input.pixels.width || decoded.height !== input.pixels.height) throw new Error('Decoded size differs from the picture');
        out.decodedSha256 = await sha256(decoded.data);
        if (row.fidelity === 'exact') out.exact = out.decodedSha256 === input.rgbaSha256;
        if (row.fidelity === 'exact' && modules.nativeDecode) {
          t = now();
          try {
            const native = await modules.nativeDecode(result.bytes);
            out.native = native ? {exact: native.width === input.pixels.width && native.height === input.pixels.height
              && await sha256(native.data) === input.rgbaSha256, ms: now() - t} : {available: false};
          } catch (e) { out.native = {exact: false, error: error(e)}; }
        }
      }
      t = now();
      const receipt = await modules.verify(row.operation === 'recompress' ? input.bytes : input.pixels, result);
      out.verifyMs = now() - t;
      out.verified = receipt.verified === true;
      out.verification = {kind: receipt.kind, ...(receipt.metric && {metric: receipt.metric, score: receipt.score}),
        ...(receipt.floor !== undefined && {floor: receipt.floor})};
      out.status = out.verified && out.exact !== false && out.sameBytes !== false ? 'pass' : 'fail';
    } catch (e) {
      out.error = error(e);
      if (e?.verification) out.verification = {verified: false, kind: e.verification.kind, score: e.verification.score, reason: e.verification.reason};
    }
    onRow(out);
  }
  const passed = record.rows.filter(r => r.status === 'pass').length;
  record.summary = {rows: record.rows.length, passed, failed: record.rows.length - passed,
    compared: record.rows.filter(r => r.sameBytes !== null).length,
    native: modules.nativeDecode ? {checked: record.rows.filter(r => r.native && r.native.available !== false).length,
      mismatched: record.rows.filter(r => r.native?.exact === false).length} : null};
  record.status = passed === record.rows.length && record.pictures.every(p => !p.error) ? 'pass' : 'fail';
  record.elapsedMs = now() - started;
  return record;
}
