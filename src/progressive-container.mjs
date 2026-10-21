// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {SIGNATURE, FTYP, BRAND, LEVEL, PARTIAL, boxHeader} from './container.mjs';
import {inspectContainer, reframeContainer, containerBoxHeader} from './container-advanced.mjs';
import {readFrames} from './framing.mjs';
import {withCompressedMetadata} from './metadata.mjs';

const invalid = message => fault('JXL_INPUT', message);
const canceled = signal => { if (signal?.aborted) throw signal.reason ?? invalid('JPEG XL delivery was canceled.'); };
function bounded(length, maximum) {
  if (!Number.isSafeInteger(length) || length > maximum) throw fault('JXL_SIZE', 'The progressive container exceeds maxBytes.');
  return length;
}
function settings(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('Progressive container options are an object.');
  const {chunkSize = 65536, maxBytes = 16777216, extended = false, metadataPlacement = 'after', signal, level, iccBitLength} = options;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 0x7fffffff) throw invalid('chunkSize is an integer from 1 through 2147483647.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw invalid('maxBytes is a positive safe integer.');
  if (typeof extended !== 'boolean') throw invalid('extended is a boolean.');
  if (metadataPlacement !== 'before' && metadataPlacement !== 'after') throw invalid('metadataPlacement is before or after.');
  if (level !== undefined && level !== 5 && level !== 10) throw invalid('The JPEG XL level is 5 or 10.');
  if (signal !== undefined && (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) throw invalid('signal is an AbortSignal.');
  if (iccBitLength !== undefined && (!Number.isSafeInteger(iccBitLength) || iccBitLength < 1)) throw invalid('iccBitLength is a positive safe integer.');
  canceled(signal);
  return {chunkSize, maxBytes, extended, metadataPlacement, signal, level, iccBitLength};
}
function concatenate(parts, length) {
  const result = new Uint8Array(length); let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
function metadataType(entry) {
  if (entry.boxType !== 'brob') return entry.boxType;
  return String.fromCharCode(...entry.data.subarray(0, 4));
}

function landmarks(parsed) {
  const result = [];
  const add = (kind, frame, frameIndex, end, fields = {}) => result.push({kind, frameIndex,
    codestreamByteEnd: end, width: frame.width, height: frame.height, ...fields});
  if (parsed.preview) add('preview', parsed.preview, -1, parsed.preview.end);
  for (const [frameIndex, frame] of parsed.frames.entries()) {
    if (frame.type === 1) { add('lf-frame', frame, frameIndex, frame.end, {dcLevel: frame.dcLevel}); continue; }
    if (!frame.modular && frame.sizes.length > 1) {
      const dimension = 128 << frame.shift, width = Math.ceil(frame.width / frame.upsampling), height = Math.ceil(frame.height / frame.upsampling);
      const groups = Math.ceil(width / dimension) * Math.ceil(height / dimension);
      const dcGroups = Math.ceil(width / (dimension * 8)) * Math.ceil(height / (dimension * 8));
      let end = frame.sectionsAt;
      for (let i = 0; i <= dcGroups; i++) end += frame.sizes[i];
      add('low-frequency', frame, frameIndex, end, {downsample: 8});
      end += frame.sizes[dcGroups + 1];
      for (let pass = 0; pass < frame.passes; pass++) {
        for (let group = 0; group < groups; group++) end += frame.sizes[dcGroups + 2 + pass * groups + group];
        let downsample = 8;
        for (let i = 0; i < frame.lastPass.length; i++) if (frame.lastPass[i] <= pass) downsample = frame.downsample[i];
        if (pass === frame.passes - 1) downsample = 1;
        add('pass', frame, frameIndex, end, {pass, downsample});
      }
    }
    add(frame.type === 2 ? 'reference-frame' : 'frame', frame, frameIndex, frame.end);
  }
  result.push({kind: 'complete', frameIndex: parsed.frames.length - 1, codestreamByteEnd: parsed.codestream.length,
    width: parsed.image.width, height: parsed.image.height});
  return result;
}

function prepare(bytes, options) {
  const state = settings(options), source = inspectContainer(bytes, {maxBytes: state.maxBytes}), stream = source.codestream;
  const level = state.level ?? source.level;
  if (source.level === 10 && level !== 10) throw invalid('An existing level 10 declaration cannot be demoted.');
  const parsed = readFrames(stream, {iccBits: state.iccBitLength}), milestones = landmarks(parsed);
  let ftyp;
  if (bytes[0] === 255 && bytes[1] === 10) {
    ftyp = new Uint8Array(12); const view = new DataView(ftyp.buffer); view.setUint32(0, BRAND); view.setUint32(8, BRAND);
  } else {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), wide = view.getUint32(12) === 1;
    const header = wide ? 16 : 8, length = wide ? view.getUint32(20) * 4294967296 + view.getUint32(24) : view.getUint32(12);
    ftyp = bytes.slice(12 + header, 12 + length); new DataView(ftyp.buffer).setUint32(4, 0);
  }
  const prefix = [SIGNATURE.slice(), boxHeader(FTYP, ftyp.length, state.extended), ftyp], suffix = [];
  if (level === 10) prefix.push(boxHeader(LEVEL, 1, state.extended), Uint8Array.of(10));
  for (const entry of source.auxiliary) {
    const after = entry.boxType === 'jxli' || state.metadataPlacement === 'after' && ['Exif', 'xml ', 'jumb'].includes(metadataType(entry));
    const destination = after ? suffix : prefix;
    destination.push(containerBoxHeader(entry.boxType, entry.data.length, {extended: state.extended}), entry.data);
  }
  const prefixBytes = prefix.reduce((sum, bytes) => bounded(sum + bytes.length, state.maxBytes), 0);
  const suffixBytes = suffix.reduce((sum, bytes) => bounded(sum + bytes.length, state.maxBytes), 0);
  bounded(prefixBytes + suffixBytes + stream.length, state.maxBytes);
  const ends = [...new Set(milestones.map(row => row.codestreamByteEnd))].sort((a, b) => a - b), fragments = [];
  let at = 0, containerEnd = prefixBytes;
  for (const end of ends) {
    while (at < end) {
      const next = Math.min(end, at + state.chunkSize), overhead = (state.extended ? 16 : 8) + 4;
      if (fragments.length >= 0x80000000) throw fault('JXL_SIZE', 'A JPEG XL stream has at most 2147483648 fragments.');
      bounded(containerEnd + next - at + overhead + suffixBytes + stream.length - next, state.maxBytes);
      const fragment = {index: fragments.length, codestreamByteStart: at, codestreamByteEnd: next,
        containerByteStart: containerEnd, containerByteEnd: containerEnd + overhead + next - at, last: next === stream.length};
      fragments.push(fragment); containerEnd = fragment.containerByteEnd; at = next;
    }
  }
  const byEnd = new Map(fragments.map(row => [row.codestreamByteEnd, row.containerByteEnd]));
  for (const row of milestones) row.containerByteEnd = byEnd.get(row.codestreamByteEnd);
  const layout = {width: parsed.image.width, height: parsed.image.height, level, codestreamBytes: stream.length,
    containerBytes: bounded(containerEnd + suffixBytes, state.maxBytes), prefixBytes, suffixBytes, fragments, milestones};
  return {state, stream, prefix, suffix, layout};
}

export function progressiveContainerPlan(bytes, options = {}) { return prepare(bytes, options).layout; }

function* emit(plan) {
  const {state, stream, prefix, suffix, layout} = plan;
  canceled(state.signal); yield concatenate(prefix, layout.prefixBytes);
  for (const part of layout.fragments) {
    canceled(state.signal);
    const length = part.codestreamByteEnd - part.codestreamByteStart, header = boxHeader(PARTIAL, length + 4, state.extended);
    const chunk = new Uint8Array(header.length + 4 + length); chunk.set(header);
    new DataView(chunk.buffer).setUint32(header.length, part.index + (part.last ? 0x80000000 : 0));
    chunk.set(stream.subarray(part.codestreamByteStart, part.codestreamByteEnd), header.length + 4); yield chunk;
  }
  if (layout.suffixBytes) { canceled(state.signal); yield concatenate(suffix, layout.suffixBytes); }
}

export function progressiveContainerChunks(bytes, options = {}) { return emit(prepare(bytes, options)); }

export function withProgressiveContainer(bytes, options = {}) {
  const plan = prepare(bytes, options); return concatenate(Array.from(emit(plan)), plan.layout.containerBytes);
}

export function streamProgressiveContainer(bytes, options = {}) {
  const state = settings(options);
  const pending = options.metadata === undefined ? null : withCompressedMetadata(reframeContainer(bytes, {maxBytes: state.maxBytes}), options.metadata)
    .then(bytes => ({bytes}), error => ({error, failed: true}));
  const ready = pending ? null : prepare(bytes, state);
  return (async function* () {
    const prepared = pending ? await pending : null;
    if (prepared?.failed) throw prepared.error;
    const plan = ready ?? prepare(prepared.bytes, state);
    yield* emit(plan);
  })();
}
