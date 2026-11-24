// SPDX-License-Identifier: MIT
import {DECODER_SNAPSHOT} from '../shown-picture.mjs';
import {SAVED, PASSED, tiledBytes, readEach, journalNext, journalRequest} from '../step-journal.mjs';
import {sha256Start, sha256Update, sha256Finish} from '../sha256.mjs';
import {boundedHeaderSteps, firstFrameNoise} from './inspect.mjs';
import {check, fail, PIXELS, dimensions, object, pixelLimit} from './primitives.mjs';
import {decodeGroupFile, decodeWholeFile, decodeWithoutNoise, boundedWithoutNoise, needsSetup, readsWithoutNoise, restorationSteps, verificationImageSteps, ownJPEGReference, jpegReferenceSteps, nativeVerification, shown, verifyDecodeOptions as decodeOptions, displaySize} from './verify-decode.mjs';
import {fromDecoded} from './describe.mjs';
import {pngLayout, pngRows, pngPassRows, pngOrientationLocation, unfilterRow, pngRowKernels} from '../source.mjs';
import {pngWalk, crc32} from '../png-chunks.mjs';
import {jpegDisplayDimensionsSteps} from './preparation-jpeg.mjs';
import {scoreInSteps} from './verify-score.mjs';
import {orientInSteps, resizeInSteps} from './verify-transforms.mjs';
import {sampleView} from './verify-samples.mjs';
import {verificationRows} from './verify-work.mjs';
import {isImageResult} from './result-shape.mjs';
const WHOLE_FRAME = Symbol.for('rapier-jxl.verify.whole-frame');
import {storedIdentity} from './identity-record.mjs';
import {refOf} from '../resumable-encode.mjs';

const GROUP = 256, HASH_BYTES = 1 << 20;
const PROFILE_BYTES = 65536;
const DECODE_FIELDS = ['format','extraChannels','colorEncoding','icc','rgbaColorEncoding','rgbaICC','alphaPremultiplied',
  'orientation','orientationApplied','animation','bitDepth','sampleFormat','colorSpace','transferFunction','header','colorScope'];
const isJXL = head => head[0] === 255 && head[1] === 10 || head[0] === 0 && head[4] === 74 && head[5] === 88 && head[6] === 76;
function fileBlob(bytes,BlobType = Blob) {
  const parts = [];
  for (let at = 0; at < bytes.length; at += HASH_BYTES) parts.push(() => bytes.subarray(at,Math.min(bytes.length,at + HASH_BYTES)));
  return new BlobType(readEach(parts));
}
async function pngReference(file,options,{journal},metadata = false) {
  const head = file.subarray(0,Math.min(file.length,32));
  if (![137,80,78,71,13,10,26,10].every((v,i) => head[i] === v)) return null;
  if (head.length < 24) throw fail('JXL_INPUT',"png header: incomplete");
  const view = new DataView(head.buffer,head.byteOffset,head.byteLength);
  dimensions(view.getUint32(16),view.getUint32(20),options.maxPixels);
  await pngRowKernels();
  const borrowed = Object.assign(request => journal(request.cold ? {...request,borrowed:true} : request),journal);
  return journal.tools.pngPixels(borrowed,file,{readAs:options.readAs,deep:true,orient:true,metadata,
    reader:{pngWalk,pngLayout,pngRows,pngPassRows,pngOrientationLocation,unfilterRow}});
}

async function nativeReferenceInSteps(bytes,size,options,context) {
  const {journal,unit} = context, {nativeBitmap,requirePNGReader} = context.tools, head = bytes.subarray(0,Math.min(bytes.length,32));
  let geometry = size;
  if (head[0] === 255 && head[1] === 216)
    await drain(jpegDisplayDimensionsSteps(bytes,options.maxPixels,value => { geometry = value; }),journal);
  else if ([137,80,78,71,13,10,26,10].every((v,i) => head[i] === v)) {
    if (head[24] === 16) requirePNGReader({readAs:options.readAs});
    geometry = await pngReference(bytes,options,context,true);
  } else if (isJXL(head)) geometry = displaySize(await drain(boundedHeaderSteps(bytes),journal));
  const {width,height,orientation = 1,orientationAt,orientationBig,exifAt,exifLength} = geometry;
  dimensions(width,height,options.maxPixels);
  let blob, description;
  const nativeSource = () => {
    const original = fileBlob(bytes);
    if (!(orientation > 1)) return original;
    const value = Uint8Array.of(orientationBig ? 0 : 1,orientationBig ? 1 : 0);
    if (exifAt !== undefined) {
      const chunk = bytes.subarray(exifAt - 4,exifAt + exifLength).slice();
      chunk.set(value,orientationAt - exifAt + 4);
      const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0,crc32(chunk));
      return new Blob([original.slice(0,exifAt - 4),chunk,crc,original.slice(exifAt + exifLength + 4)]);
    }
    return new Blob([original.slice(0,orientationAt),value,original.slice(orientationAt + 2)]);
  };
  const bands = [];
  for (let y = 0; y < height; y += GROUP) {
    const band = [];
    for (let x = 0; x < width; x += GROUP) {
      const w = Math.min(GROUP,width - x), h = Math.min(GROUP,height - y);
      const {value} = await unit('verify-native-group',async () => {
        blob ??= nativeSource();
        const picture = await nativeBitmap(blob,options,{maxPixels:options.maxPixels,signal:options.signal},
          {region:{x,y,width:w,height:h},platform:() => 'source: RGBA/PNG; JPEG: jpegxl/jpeg recompress'});
        if (picture.width !== w || picture.height !== h) throw fail('JXL_PLATFORM',"decoder: crop dimensions");
        return {data:new Uint8Array(picture.data.buffer,picture.data.byteOffset,picture.data.byteLength),colorSpace:picture.colorSpace};
      },{cold:true,alone:true});
      description ??= {colorSpace:value.colorSpace};
      band.push(value.data);
    }
    bands.push(band);
  }
  const picture = {...description,width,height,data:tiledBytes(bands,width,height,GROUP,GROUP,journal.touched),
    ...(orientation > 1 && {orientation})};
  return orientInSteps(picture,context);
}

const verificationUnit = journal => async (name,run,flags = {}) => {
  const saved = await journal({unit:name,...flags,...(flags.cold && {borrowed:true})});
  if (saved && Object.hasOwn(saved,SAVED)) return {value:saved[SAVED]};
  let value;
  try { value = await run(); } catch (error) { await journal({unitFailed:name}); throw error; }
  await journal({unitDone:name,value});
  return {value};
};
export async function outputDigest(bytes,journal) {
  let state = sha256Start();
  const unit = verificationUnit(journal);
  for (let at = 0; at < bytes.length; at += HASH_BYTES) {
    const {value} = await unit('output-hash',() => sha256Update(state,bytes.subarray(at,Math.min(bytes.length,at + HASH_BYTES))),{carry:true});
    if (value !== PASSED) state = value;
  }
  return 'sha256:' + sha256Finish(state);
}

export function storedVerificationSteps(verify, ordinary) {
  return Object.freeze({id:'verify',eager:false,
    normalize(given,source) {
      const options = object(given), unknown = Object.keys(options).find(key => !['result','parts','maxPixels'].includes(key));
      if (unknown) throw fail('JXL_OPTIONS',`unknown field: ${unknown}; use result, parts, maxPixels`);
      const result = object(options.result,'Stored result');
      if (Object.hasOwn(result,'bytes') || Object.hasOwn(result,'verification') || !isImageResult({...result,bytes:Uint8Array.of(0)}))
        throw fail('JXL_INPUT','verification metadata: encode metadata without bytes or verification');
      const maxPixels = options.maxPixels === undefined && result.kept === 'jpeg-bytes' ? PIXELS : pixelLimit(options.maxPixels);
      dimensions(result.width,result.height,maxPixels);
      const kind = source.kind ?? 'pixels';
      if (kind === 'pixels') {
        dimensions(source.width,source.height,maxPixels);
        if (source.byteLength !== source.width * source.height * 4)
          throw fail('JXL_INPUT','pixels: width*height*4 RGBA8; kind: \'file\' for PNG/JPEG');
      } else if (kind !== 'file') throw fail('JXL_INPUT',"source kind: pixels or file");
      if (!Array.isArray(options.parts) || !options.parts.length || options.parts.some(ref => !refOf(ref).length) ||
          options.parts.reduce((size,ref) => size + ref.length,0) > 0xffffffff)
        throw fail('JXL_INPUT',"parts: nonempty ordered immutable");
      return {options:{...options},maxPixels};
    },
    async run(plan,data,source,journal) {
      const unit = verificationUnit(journal), pieces = [];
      for (const ref of plan.options.parts) {
        const {value} = await unit('verify-candidate-part',() => journal.part(ref),{cold:true,alone:true});
        pieces.push(value);
      }
      const bytes = journal.join(pieces), result = {...plan.options.result,bytes};
      const original = (source.kind ?? 'pixels') === 'file' ? data : {data,width:source.width,height:source.height,
        ...(source.colorSpace && {colorSpace:source.colorSpace})};
      const facts = await verify(original,result,{journal,source,sourceIdentity:await storedIdentity(source),
        outputDigest:await outputDigest(bytes,journal),pixelResult:pixelResultInSteps,restored:restoredInSteps,maxPixels:plan.maxPixels});
      return {bytes:new Uint8Array(0),facts};
    },
    ...(ordinary && {async straight(plan,data,source,signal,part,host) {
      const pieces = [];
      for (const ref of plan.options.parts) pieces.push(await part(ref));
      const bytes = new Uint8Array(pieces.reduce((n,p) => n + p.length,0));
      let at = 0;
      for (const piece of pieces) { bytes.set(piece,at); at += piece.length; }
      const original = (source.kind ?? 'pixels') === 'file' ? data : {data,width:source.width,height:source.height,...(source.colorSpace && {colorSpace:source.colorSpace})};
      const facts = await ordinary(original,{...plan.options.result,bytes},{signal,maxPixels:plan.maxPixels,...(host && DECODER_SNAPSHOT in host && {[DECODER_SNAPSHOT]:host[DECODER_SNAPSHOT]})});
      return {bytes:new Uint8Array(0),facts};
    }}),
    record(bytes,plan,source,facts) {
      if (bytes.length || facts?.verified !== true) throw fail('JXL_INPUT',"verification: completed receipt");
      return facts;
    }});
}
const namedContext = (context,prefix) => {
  const journal = Object.assign(request => context.journal(Object.fromEntries(Object.entries(request)
    .map(([key,value]) => [key,['unit','unitDone','unitFailed'].includes(key) ? prefix + value : value]))),
    {tools:context.journal.tools,touched:context.journal.touched,join:context.journal.join,step:context.journal.step});
  return {...context,journal,unit:verificationUnit(journal)};
};

async function drain(steps,journal) {
  let reply, failed = false;
  try {
    for (;;) {
      const step = journalNext(steps,reply,journal);
      if (step.done) return step.value;
      reply = journalRequest(step.value) ? await journal(step.value) : undefined;
    }
  } catch (error) { failed = true; throw error; }
  finally { try { steps.return?.(); } catch (error) { if (!failed) throw error; } }
}

export async function restoredInSteps(bytes,expected,options,context) {
  const steps = context.restoreSteps ?? restorationSteps(context);
  if (!steps?.open || !steps?.normalize) throw fail('JXL_PLATFORM','restore: configureDecoder(decode, restore) from jpegxl/jpeg');
  const maxPixels = Math.min(options.maxPixels,PIXELS), plan = steps.normalize({maxPixels});
  const restored = await drain(steps.open(plan,bytes),context.journal), unit = verificationUnit(context.journal);
  let state = {hash:sha256Start(),equal:restored.bytes.length === expected.length};
  for (let at = 0; at < restored.bytes.length; at += HASH_BYTES) {
    const end = Math.min(restored.bytes.length,at + HASH_BYTES);
    const {value} = await unit('verify-restored-bytes',() => {
      const [actual,before] = readEach([() => restored.bytes.subarray(at,end),() => expected.subarray(at,Math.min(expected.length,end))]);
      return {hash:sha256Update(state.hash,actual),equal:state.equal && actual.length === before.length && actual.every((v,i) => v === before[i])};
    },{carry:true});
    if (value !== PASSED) state = value;
  }
  const size = options.format === 'jpeg' ? state.equal ? restored.facts
    : await drain(jpegDisplayDimensionsSteps(expected,options.maxPixels),context.journal)
    : displaySize(await drain(boundedHeaderSteps(bytes),context.journal));
  return {size,equal:state.equal,digest:'sha256:' + sha256Finish(state.hash)};
}

const GROUP_PIECE_ROWS = 64;
async function decodedGroups(bytes,options,{journal,unit,tools},hostOnly = false,djxl = false,withoutNoise = false) {
  const {nativePictureWith,NATIVE_PICTURE_OPTIONS} = tools;
  const info = await drain(boundedHeaderSteps(bytes),journal);
  dimensions(info.width,info.height,options.maxPixels);
  if (info.animation) throw fail('JXL_UNSUPPORTED','animation: use verify()');
  const {value:native} = await unit('verify-decode-reader',() => !hostOnly && nativeVerification(info,decodeOptions(options),true));
  const complete = () => wholeDecoded(bytes,info,options,unit,djxl && !native ? tools : null,withoutNoise ? withoutNoiseFile : decodeWholeFile);
  const opened = native ? null : await drain(verificationImageSteps(bytes,decodeOptions(options)),journal);
  const group = native ? GROUP : opened.group;
  if (![128,256,512,1024].includes(group)) throw fail('JXL_DECODE',"decoder group: 128|256|512|1024");
  let blob, firstData = null;
  const decodeTile = async (x,y,width,height) => {
    let picture;
    try {
      picture = native ? shown(info,await nativePictureWith(bytes.subarray(0,Math.min(bytes.length,32)),
        {width,height,colorSpace:info.colorEncoding.primaries,maxPixels:options.maxPixels,signal:options.signal},(makeBitmap,BlobType) => {
          blob ??= fileBlob(bytes,BlobType);
          return () => makeBitmap.call(globalThis,blob,x,y,width,height,NATIVE_PICTURE_OPTIONS);
        }),native) : await decodeGroupFile(bytes,{...decodeOptions(options),region:{x,y,width,height},
          maxTotalSamples:Math.max(1048576,GROUP * GROUP * 108)},opened,withoutNoise);
    } catch (error) { if (!native && error?.[WHOLE_FRAME] === true) return {whole:true}; throw error; }
    if (![Uint8Array,Uint8ClampedArray,Uint16Array,Float32Array].some(T => picture.data instanceof T) || picture.width !== width || picture.height !== height)
      throw fail('JXL_UNSUPPORTED',"decoder: complete typed RGBA groups");
    return {type:picture.data instanceof Uint16Array ? 'Uint16Array' : picture.data instanceof Float32Array ? 'Float32Array' : 'Uint8Array',
      data:new Uint8Array(picture.data.buffer,picture.data.byteOffset,picture.data.byteLength),description:Object.fromEntries(DECODE_FIELDS.filter(key => picture[key] !== undefined)
      .map(key => [key,key === 'extraChannels' ? picture[key].map(({data,plane,...channel}) => channel) : picture[key]]))};
  };
  const {value:first} = await unit('verify-decode-description',async () => {
    const picture = await decodeTile(0,0,Math.min(group,info.width),Math.min(group,info.height));
    if (picture.whole) return picture;
    firstData = picture.data;
    return {type:picture.type,description:picture.description};
  });
  if (first.whole) return complete();
  const description = first.description, Type = {Uint8Array,Uint16Array,Float32Array}[first.type], bands = [], size = Type.BYTES_PER_ELEMENT;
  const dithered = djxl && !native && !!tools.nativeGammaRGBA && first.type === 'Uint8Array' && description.bitDepth === 8 &&
    description.sampleFormat === 'uint' && description.colorSpace === 'srgb' && description.transferFunction === 'srgb' &&
    (description.orientation === 1 || description.orientationApplied) && !description.animation;
  let nativeBands = dithered ? [] : null;
  const djxlGroup = async (x,y,width,height) => {
    let float;
    try { float = await decodeGroupFile(bytes,{...decodeOptions(options),colorSpace:'srgb',format:'float32',region:{x,y,width,height},
      maxTotalSamples:Math.max(1048576,GROUP * GROUP * 108)},opened,withoutNoise); }
    catch (error) { check(options.signal); if (error?.code === 'JXL_UNSUPPORTED' || needsSetup(error)) return null; throw error; }
    const n = width * height, data = float.data, channels = data.length / n;
    if (!(data instanceof Float32Array) || (channels !== 3 && channels !== 4)) return null;
    const planes = [new Float32Array(n),new Float32Array(n),new Float32Array(n)];
    for (let i = 0,at = 0; i < n; i++,at += channels) for (let c = 0; c < 3; c++) planes[c][i] = data[at + c];
    const out = (await tools.compileKernels(), tools.nativeGammaRGBA(planes,width,height,{x,y}));
    for (let i = 0; i < n; i++) out[i * 4 + 3] = channels === 4 ? Math.round(Math.min(1,Math.max(0,data[i * 4 + 3])) * 255) : 255;
    return out;
  };
  for (let y = 0; y < info.height; y += group) {
    const height = Math.min(group,info.height - y), band = Array.from({length:Math.ceil(height / GROUP_PIECE_ROWS)},() => []);
    const nativeBand = nativeBands && band.map(() => []);
    for (let x = 0; x < info.width; x += group) {
      const width = Math.min(group,info.width - x), rowBytes = width * 4 * size;
      let samples = null;
      for (let p = 0; p < band.length; p++) {
        const {value} = await unit(p ? 'verify-decode-group-rows' : 'verify-decode-group',async () => {
          if (!samples) {
            if (!x && !y && firstData) samples = firstData;
            else { const picture = await decodeTile(x,y,width,height); if (picture.whole) return picture; samples = picture.data; }
          }
          return samples.slice(p * GROUP_PIECE_ROWS * rowBytes,Math.min(height,(p + 1) * GROUP_PIECE_ROWS) * rowBytes);
        },{cold:true,alone:true,...(p && {tail:true})});
        if (!(value instanceof Uint8Array) && value.whole) return complete();
        band[p].push(value);
      }
      firstData = null;
      let shown = null;
      if (nativeBands) for (let p = 0; p < band.length; p++) {
        const {value} = await unit(p ? 'verify-djxl-group-rows' : 'verify-djxl-group',async () => {
          shown ??= await djxlGroup(x,y,width,height);
          return shown && shown.slice(p * GROUP_PIECE_ROWS * width * 4,Math.min(height,(p + 1) * GROUP_PIECE_ROWS) * width * 4);
        },{cold:true,alone:true,...(p && {tail:true})});
        if (value === null) { nativeBands = null; break; }
        nativeBand[p].push(value);
      }
    }
    bands.push(...band);
    if (nativeBands) nativeBands.push(...nativeBand);
  }
  return {...description,width:info.width,height:info.height,
    data:sampleView(tiledBytes(bands,info.width * size,info.height,GROUP_PIECE_ROWS,group * size,journal.touched),Type),
    ...(nativeBands && {native:sampleView(tiledBytes(nativeBands,info.width,info.height,GROUP_PIECE_ROWS,group,journal.touched),Uint8Array)})};
}

async function wholeDecoded(bytes,info,options,unit,tools = null,decodeAll = decodeWholeFile) {
  const {value} = await unit('verify-decode-whole',async () => {
    const picture = await decodeAll(bytes,decodeOptions(options));
    if (![Uint8Array,Uint8ClampedArray,Uint16Array,Float32Array].some(T => picture.data instanceof T) || picture.width !== info.width || picture.height !== info.height)
      throw fail('JXL_UNSUPPORTED',"decoder: complete typed RGBA samples");
    return {type:picture.data instanceof Uint16Array ? 'Uint16Array' : picture.data instanceof Float32Array ? 'Float32Array' : 'Uint8Array',
      data:new Uint8Array(picture.data.buffer,picture.data.byteOffset,picture.data.byteLength),description:Object.fromEntries(DECODE_FIELDS.filter(key => picture[key] !== undefined)
      .map(key => [key,key === 'extraChannels' ? picture[key].map(({data,plane,...channel}) => channel) : picture[key]]))};
  },{cold:true,alone:true});
  const d = value.description, read = tools?.nativeGammaRGBA && value.type === 'Uint8Array' && d.bitDepth === 8 && d.sampleFormat === 'uint' &&
    d.colorSpace === 'srgb' && d.transferFunction === 'srgb' && (d.orientation === 1 || d.orientationApplied) && !d.animation;
  let native = null;
  if (read) ({value:native} = await unit('verify-djxl-whole',async () => {
    let float;
    try { float = await decodeAll(bytes,{...decodeOptions(options),colorSpace:'srgb',format:'float32'}); }
    catch (error) { check(options.signal); if (error?.code === 'JXL_UNSUPPORTED' || needsSetup(error)) return null; throw error; }
    const n = info.width * info.height, data = float.data, channels = data.length / n;
    if (!(data instanceof Float32Array) || (channels !== 3 && channels !== 4) || float.width !== info.width || float.height !== info.height) return null;
    const planes = [new Float32Array(n),new Float32Array(n),new Float32Array(n)];
    for (let i = 0,at = 0; i < n; i++,at += channels) for (let c = 0; c < 3; c++) planes[c][i] = data[at + c];
    const out = (await tools.compileKernels(), tools.nativeGammaRGBA(planes,info.width,info.height));
    for (let i = 0; i < n; i++) out[i * 4 + 3] = channels === 4 ? Math.round(Math.min(1,Math.max(0,data[i * 4 + 3])) * 255) : 255;
    return out;
  },{cold:true,alone:true}));
  return {...d,width:info.width,height:info.height,data:sampleView(value.data,{Uint8Array,Uint16Array,Float32Array}[value.type]),
    ...(native && {native:sampleView(native,Uint8Array)})};
}

async function referenceInSteps(original,options,context) {
  if (context.reference) return context.reference;
  let picture = original;
  let orient = false;
  if ((context.source?.kind ?? 'pixels') === 'file') {
    const head = original.subarray(0,Math.min(original.length,32));
    if (isJXL(head)) picture = options.readAs === undefined ? fromDecoded(await decodedGroups(original,options,context))
      : await nativeReferenceInSteps(original,options.size,options,context);
    else if (head[0] === 255 && head[1] === 216 && options.readAs === undefined && ownJPEGReference(context)) {
      const steps = jpegReferenceSteps(context);
      if (!steps) throw fail('JXL_PLATFORM','restore: configureDecoder(decode, restore) from jpegxl/jpeg');
      await steps.prepare?.();
      const encoded = await drain(steps.open(steps.normalize({effort:1,maxPixels:Math.min(options.maxPixels,PIXELS)}),original),context.journal);
      picture = fromDecoded(await decodedGroups(encoded.bytes,options,context,true)); orient = true;
    }
    else { picture = await pngReference(original,options,context); orient = !!picture; }
    if (!picture) {
      if (head[0] === 255 && head[1] === 216 || [137,80,78,71,13,10,26,10].every((v,i) => head[i] === v))
        picture = await nativeReferenceInSteps(original,options.size,options,context);
      else throw fail('JXL_UNSUPPORTED','source: use verify()');
    }
  }
  if (orient || options.transform) picture = await orientInSteps(picture,context);
  if (options.transform) picture = await resizeInSteps(picture,options.transform.width,options.transform.height,options,context);
  return picture;
}

const withoutNoiseFile = async (file,options) => await decodeWithoutNoise(file,options) ?? Promise.reject(fail('JXL_UNSUPPORTED',"decoder: noise-free samples"));

async function noiseOffInSteps(bytes,reference,decoded,decodedEvidence,compared,fidelity,options,context) {
  const decodedScore = decodedEvidence.proof.score, {value:carries} = await context.unit('verify-noise-flag',() => firstFrameNoise(bytes));
  if (carries === false) return decodedEvidence;
  if (!readsWithoutNoise(options)) return carries === true && compared.alphaExact ? context.tools.noiseUnread(decodedEvidence) : decodedEvidence;
  const plain = boundedWithoutNoise(options) ? await decodedGroups(bytes,options,context,true,true,true)
    : await wholeDecoded(bytes,{width:decoded.width,height:decoded.height},options,context.unit,context.tools,withoutNoiseFile);
  let readings = 0;
  const evidence = await context.tools.pixelEvidence(reference,plain,fidelity,options,compared,
    (before,after,profile,encoding,_options,arithmetic) => scoreInSteps(before,after,profile,encoding,
      arithmetic === 'libjxl' ? context : readings++ ? namedContext(context,'djxl-') : context,arithmetic));
  return {...evidence,proof:{...evidence.proof,view:'without-noise',...(Number.isFinite(decodedScore) && {decodedScore})}};
}

export async function pixelResultInSteps(bytes,original,{fidelity,format,size,outputDigest,details,options,noiseOff = false},context) {
  const {comparison,comparisonContext,pictureICC,conversionProfile,sameBytes,pixelEvidence,protectionDomain,protectionEvidence,
    describedIdentity,sampleBytes,profileTransformSteps} = context.tools;
  const unit = verificationUnit(context.journal), here = {...context,unit};
  const withSnap = {...options, ...(context && DECODER_SNAPSHOT in context && {[DECODER_SNAPSHOT]:context[DECODER_SNAPSHOT]})};
  const reference = await referenceInSteps(original,{...withSnap,size},namedContext(here,'reference-'));
  const outputContext = namedContext(here,'output-');
  const djxl = format === 'jxl' && fidelity !== 'exact' && !!context.tools.measurementTarget && context.tools.measurementTarget(fidelity,options).metric === 'ssimulacra2';
  const decoded = format === 'jxl' ? await decodedGroups(bytes,withSnap,outputContext,false,djxl)
    : await pngReference(bytes,{...options,readAs:undefined},outputContext);
  if (!decoded) throw fail('JXL_UNSUPPORTED','output: use verify()');
  if (options.protection) protectionDomain(options.protection,reference,decoded);
  const a = pictureICC(reference), b = pictureICC(decoded);
  let equalICC = !!a && !!b && a.length === b.length;
  if (equalICC) for (let at = 0; at < a.length; at += PROFILE_BYTES) {
    const {value} = await unit('verify-profile-bytes',() => {
      const [before,after] = readEach([a,b].map(profile => () => profile.subarray(at,Math.min(profile.length,at + PROFILE_BYTES))));
      return equalICC && sameBytes(before,after);
    },{carry:true});
    if (value !== PASSED) equalICC = value;
  }
  const profileInput = conversionProfile(reference,decoded);
  const transform = profileInput ? await drain(profileTransformSteps(profileInput),context.journal) : null;
  const {value:meaning} = await unit('verify-compare-description',() => comparisonContext(reference,decoded,
    transform,equalICC));
  const knownIdentity = reference === original ? context.sourceIdentity : null;
  let state = {compared:comparison({...reference,data:new reference.data.constructor(0)},{...decoded,data:new decoded.data.constructor(0)},options.protection,0,meaning),
    hash:knownIdentity ? null : sha256Start()};
  const rowLimit = verificationRows(reference.width);
  for (let y = 0; y < reference.height; y += rowLimit) {
    const height = Math.min(rowLimit,reference.height - y);
    const {value} = await unit('verify-compare-rows',() => {
      for (const picture of [reference,decoded]) picture.data.ahead?.(y * picture.width * 4,(y + height) * picture.width * 4);
      const [before,after] = readEach([reference,decoded].map(picture => () => ({...picture,height,
        data:picture.data.subarray(y * picture.width * 4,(y + height) * picture.width * 4)})));
      const measured = comparison(before,after,options.protection,y * reference.width,meaning), previous = state.compared;
      const compared = {...previous,...measured,exact:previous.exact && measured.exact,alphaExact:previous.alphaExact && measured.alphaExact,
        supported:previous.supported && measured.supported,maxError:Math.max(previous.maxError,measured.maxError),
        ...((previous.colorScope || measured.colorScope) && {colourSamples:(previous.colourSamples ?? 0) + (measured.colourSamples ?? 0),
          visible:Boolean(previous.visible || measured.visible)}),
        ...(options.protection && {protectedSamples:previous.protectedSamples + (measured.protectedSamples ?? 0),
          protectedExact:previous.protectedExact && measured.protectedExact === true})};
      return {compared,hash:state.hash && sha256Update(state.hash,sampleBytes(before.data))};
    },{carry:true});
    if (value !== PASSED) state = value;
  }
  const referenceIdentity = knownIdentity ?? await describedIdentity(reference,{data:'sha256:' + sha256Finish(state.hash)},new reference.data.constructor(0),
    async profile => {
      let hash = sha256Start();
      for (let at = 0; at < profile.length; at += PROFILE_BYTES) {
        const {value} = await unit('verify-reference-icc-hash',() => sha256Update(hash,profile.subarray(at,Math.min(profile.length,at + PROFILE_BYTES))),{carry:true});
        if (value !== PASSED) hash = value;
      }
      return 'sha256:' + sha256Finish(hash);
    });
  let readings = 0, evidence = await pixelEvidence(reference,decoded,fidelity,options,state.compared,
    (before,after,profile,encoding,_options,arithmetic) => scoreInSteps(before,after,profile,encoding,
      arithmetic === 'libjxl' ? here : readings++ ? namedContext(here,'djxl-') : here,arithmetic));
  if (noiseOff && format === 'jxl' && evidence.proof.metric === 'ssimulacra2')
    evidence = await noiseOffInSteps(bytes,reference,decoded,evidence,state.compared,fidelity,withSnap,namedContext(here,'noise-off-'));
  evidence = protectionEvidence(evidence,state.compared,options);
  check(options.signal);
  return {...displaySize(decoded),kept:evidence.kept,proof:{...evidence.proof,outputDigest,referenceDigest:referenceIdentity.digest,...details},
    meetsTarget:evidence.proof.verified,...(evidence.reason && {reason:evidence.reason})};
}
