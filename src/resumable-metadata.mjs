// SPDX-License-Identifier: MIT
import {unit, carried, stage, PASSED, journalJoin, sliceBytes, joinedBytes} from './step-journal.mjs';

function windowByte(bytes) {
  if (ArrayBuffer.isView(bytes)) return at => bytes[at];
  const windows = new Map();
  return at => {
    const from = Math.floor(at / 65536) * 65536; let part = windows.get(from);
    if (!part) { part = bytes.subarray(from, Math.min(bytes.length, from + 65536)); windows.set(from, part); if (windows.size > 8) windows.delete(windows.keys().next().value); }
    return part[at - from];
  };
}
function previousByte(parts, require) {
  const cache = new Map();
  return at => {
    if (at < 0) return undefined;
    let lo = 0, hi = parts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (parts[mid].at <= at) lo = mid + 1; else hi = mid; }
    const part = parts[lo]; require(part && part.from <= at);
    if (ArrayBuffer.isView(part.bytes)) return part.bytes[at - part.from];
    let bytes = cache.get(lo);
    if (!bytes) { bytes = part.bytes.subarray(0, part.at - part.from); cache.set(lo, bytes); if (cache.size > 8) cache.delete(cache.keys().next().value); }
    return bytes[at - part.from];
  };
}
const entropyCursor = code => ({remaining: code.remaining, state: code.state, position: code.position, left: code.left, distance: code.distance,
  history: code.history?.slice(0, Math.min(code.position, code.history.length)) ?? null});
function resumeEntropy(code, saved) {
  const {history, ...cursor} = saved; Object.assign(code, cursor); code.finished = false;
  if (history) { code.begin(); code.history.set(history); }
}

function* unpackInput(bytes,limits,owner) {
  return yield* stage('decode-input',function*(){
    if(yield* unit('decode-input-signature',()=>owner.admitInput(bytes,limits)))return {codestream:bytes,boxes:[],container:null};
    let state={at:12,count:0,rawMetadata:0};
    while(state.at<bytes.length){
      const batch=yield* unit('decode-storage',()=>{
        const next={...state},view=owner.uint32View(sliceBytes(bytes,0));let repair=null;
        for(let n=0;n<64&&next.at<bytes.length;n++)repair=owner.storageNext(bytes,limits,next,view)||repair;
        return {state:next,repair};
      });
      state=batch.state;
      if(batch.repair){
        const patch=yield* unit('decode-cut-header',()=>owner.repairedHeader(bytes,batch.repair));
        bytes=joinedBytes([sliceBytes(bytes,0,batch.repair.at),patch,sliceBytes(bytes,batch.repair.at+patch.length)]);
      }
    }
    const source=yield* unit('decode-container',()=>owner.readContainer(bytes,{maxBytes:limits.maxInputBytes,maxBoxes:limits.maxBoxes}));
    const metadata=[];let totalMetadata=0;
    for(const box of source.auxiliary){
      const value=yield* stage('decode-metadata',function*(){
        const compressed=box.boxType==='brob';let type=box.boxType,data=box.data;
        if(compressed){
          type=yield* unit('decode-metadata-type',()=>owner.fourCC(owner.uint32View(data.subarray(0,4)).getUint32(0)));
          data=yield* owner.part('brotli').decompressBrotliSteps(sliceBytes(data,4),{maxOutput:limits.maxMetadataBytes-totalMetadata,dictionary:limits.dictionary});
        }
        yield* unit('decode-metadata-size',()=>{owner.requireDecode(totalMetadata+data.length<=limits.maxMetadataBytes,'JPEG XL metadata exceeds the byte limit.');return null;});
        return {type,data,compressed};
      });
      metadata.push(value);totalMetadata+=value.data.length;
    }
    return {codestream:source.codestream,boxes:metadata,container:{level:source.level,minorVersion:source.minorVersion}};
  });
}

function* openImage(bytes,options,owner) {
  return yield* stage('decode-open',function*(){
    const input=yield* unpackInput(bytes,options,owner);
    const head=yield* unit('decode-image-header',()=>{
      const r=new owner.JxlBits(sliceBytes(input.codestream,0),true),h=owner.readDecodeImageHeader(r,options);h.level=input.container?.level??5;
      return {h,bit:r.bit};
    });
    let h=head.h;const r=new owner.JxlBits(sliceBytes(input.codestream,0),true);r.bit=head.bit;
    if(h.colorEncoding.wantICC){
      const level=input.container?.level??5;
      const icc=yield* owner.part('icc').readICCSteps(r,{maxBytes:options.maxMetadataBytes,maxProfileBytes:owner.iccProfileLimit(level,options.maxMetadataBytes)});
      h={...h,icc};yield* owner.admitDecodedICCSteps(icc,h,level);
    }
    const bit=yield* unit('decode-image-align',()=>{r.align();return r.bit;});
    const group=yield* unit('decode-first-frame',()=>{
      r.bit=bit;const f=h.preview?null:owner.readDecodeFrameHeader(r,h,options);
      if(f)owner.readDecodeTOC(r,f);
      return f?.modular?f.groupDim:256;
    });
    return {input,h,bit,group};
  });
}

function* readEntropyModel(r, contexts, options, owner) {
  const saved = yield* stage('decode-entropy-model', function* () {
    const head = yield* unit('decode-entropy-header', () => owner.header(r, contexts, options)); r.bit = head.bit;
    const codes = [];
    for (let i = 0; i < head.model.configs.length; i++) {
      const part = yield* unit('decode-entropy-code', () => ({code: owner.code(r, head, i), bit: r.bit}));
      codes.push(part.code); r.bit = part.bit;
    }
    return {model: {...head.model, codes}, bit: r.bit};
  });
  r.bit = saved.bit; return saved.model;
}

function* readICC(reader, {maxBytes, maxProfileBytes}, owner) {
  const result = yield* stage('decode-icc', function* () {
    const head = yield* unit('decode-icc-length', () => owner.length(reader, maxBytes, maxProfileBytes)); reader.bit = head.bit;
    const model = yield* owner.model(reader, 41), code = owner.stream(reader, model, {values: head.size, byteHistory: true});
    let part = yield* unit('decode-icc-prefix', () => owner.prefix(reader, code, head, maxProfileBytes)); reader.bit = part.bit;
    const parts = [part.bytes];
    for (let from = part.bytes.length;; from += 65536) {
      const saved = yield* carried('decode-icc-state', () => null, () => entropyCursor(code), true);
      if (saved !== null && saved !== PASSED) resumeEntropy(code, saved);
      if (from >= head.size) break;
      part = yield* unit('decode-icc-values', () => owner.part(reader, code, from, Math.min(65536, head.size - from), part, head.start));
      reader.bit = part.bit; parts.push(part.bytes);
    }
    yield* unit('decode-icc-end', () => { code.finish(); return null; });
    return {bytes: yield* owner.decode(journalJoin(parts), {maxBytes: maxProfileBytes}), bit: reader.bit};
  });
  reader.bit = result.bit; return result.bytes;
}

export function iccProfileSteps(prefix) {
  return function* (bytes, options, owner) {
    return yield* stage(prefix, function* () {
      const first = yield* unit(prefix + '-header', () => owner.start(bytes, options?.maxBytes, windowByte(bytes))); let state = first.state;
      const parts = [{bytes: first.bytes, from: 0, at: state.at}];
      while (!state.done) {
        const part = yield* unit(prefix + '-part', () => {
          const from = state.at, next = owner.part(bytes, state, previousByte(parts, owner.require), windowByte(bytes)); state = next.state;
          return {bytes: next.bytes, from, at: state.at};
        });
        parts.push(part);
        const saved = yield* carried(prefix + '-state', () => null, () => state, true);
        if (saved !== null && saved !== PASSED) state = saved;
      }
      return journalJoin(parts.map(part => part.bytes));
    });
  };
}
const decodeICC = iccProfileSteps('decode-icc-profile');

function* admitDecodedICC(profile, header, level, owner) {
  const cmyk = yield* unit('decode-icc-space', () => owner.cmyk(profile));
  let channels;
  try { channels = yield* owner.inspect(profile, level, cmyk ? 'cmyk' : undefined); }
  catch (cause) { if (cause?.[Symbol.for('rapier-jxl.journal.unread')]) throw cause; owner.require(false, cause.message); }
  yield* unit('decode-icc-channels', () => { owner.channels(channels, cmyk, header, level); return null; });
}

function brotliSteps(p, s, t) {
  return function* (bytes, options, owner) {
    const limits = owner.limits(bytes, options);
    return yield* stage(s, function* () {
      let state = yield* unit(p + '-window', () => owner.start(bytes)); const parts = [];
      while (!state.last) {
        const result = yield* stage(p + '-meta', function* () {
          const head = yield* unit(p + '-header', () => owner.header(bytes, state, limits)); let cursor = head.state;
          if (head.kind === 'end' || head.kind === 'skip') return {parts: [], state: cursor};
          let model = null;
          if (head.kind === 'compressed') model = yield* stage(p + '-models', function* () {
            let bit = head.state.bit; const trees = [];
            for (const [count, alphabet] of owner.groups(head)) {
              const group = []; trees.push(group);
              for (let first = 0; first < count; first += 16) {
                const part = yield* unit(t, () => {
                  const r = owner.reader(bytes, bit); return {trees: owner.trees(r, Math.min(16, count - first), alphabet), bit: r.bit};
                });
                group.push(...part.trees); bit = part.bit;
              }
            }
            return {trees, bit};
          });
          if (model) cursor = {...cursor, bit: model.bit};
          const made = [];
          while (cursor.at < head.end) {
            const part = yield* unit(p + '-output', () => {
              const from = cursor.at, next = owner.part(bytes, head, model, cursor, previousByte([...parts, ...made], owner.require), limits.dictionary); cursor = next.state;
              return {bytes: next.bytes, from, at: cursor.at};
            });
            made.push(part);
            const saved = yield* carried(p + '-state', () => null, () => cursor, true);
            if (saved !== null && saved !== PASSED) cursor = saved;
          }
          return {parts: made, state: owner.metaEnd(cursor)};
        });
        parts.push(...result.parts); state = result.state;
      }
      yield* unit(p + '-end', () => { owner.end(bytes, state); return null; });
      return journalJoin(parts.map(part => part.bytes));
    });
  };
}
const decodeBrotli = brotliSteps('decode-brotli', 'decode-brotli', 'decode-brotli-trees');
const readBrotli = brotliSteps('brotli', 'brotli-read', 'brotli-models');

export const metadataTools = Object.freeze({openImage, readEntropyModel, readICC, decodeICC, admitDecodedICC, decodeBrotli, readBrotli});
