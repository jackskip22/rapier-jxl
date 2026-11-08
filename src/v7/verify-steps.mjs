// SPDX-License-Identifier: MIT
import {SAVED, PASSED, tiledBytes, readEach, journalNext, journalRequest} from '../step-journal.mjs';
import {sha256Start, sha256Update, sha256Finish} from '../sha256.mjs';
import {boundedHeaderSteps} from './inspect.mjs';
import {check, fail, JPEG_PIXELS, dimensions, object, pixelLimit, LARGEST} from './primitives.mjs';
import {decodeGroupFile, restorationSteps, verificationImageSteps, ownJPEGReference, jpegReferenceSteps, nativeVerification, shown} from './verify-decode.mjs';
import {fromDecoded} from './describe.mjs';
import {pngWalk, pngLayout, pngRows, pngPassRows, pngOrientationLocation, crc32, unfilterRow} from '../source.mjs';
import {jpegDisplayDimensionsSteps} from './preparation-jpeg.mjs';
import {scoreInSteps} from './verify-score.mjs';
import {orientInSteps, resizeInSteps} from './verify-transforms.mjs';
import {sampleView} from './verify-samples.mjs';
import {isImageResult} from './result-shape.mjs';
import {storedIdentity} from './identity-record.mjs';
import {refOf} from '../resumable-encode.mjs';

const GROUP = 256, ROWS = 64, HASH_BYTES = 1 << 20;
const PROFILE_BYTES = 65536;
const DECODE_FIELDS = ['format','extraChannels','colorEncoding','icc','rgbaColorEncoding','rgbaICC','alphaPremultiplied',
  'orientation','orientationApplied','animation','bitDepth','sampleFormat','colorSpace','transferFunction','header'];
const decodeOptions = ({signal,maxPixels}) => ({colorSpace:'original',applyOrientation:false,unpremultiplyAlpha:false,
  renderSpotColors:false,maxPixels,signal});
const displaySize = picture => picture.orientation >= 5 ? {width:picture.height,height:picture.width}
  : {width:picture.width,height:picture.height};
const isJXL = head => head[0] === 255 && head[1] === 10 || head[0] === 0 && head[4] === 74 && head[5] === 88 && head[6] === 76;
function fileBlob(bytes,BlobType = Blob) {
  const parts = [];
  for (let at = 0; at < bytes.length; at += HASH_BYTES) parts.push(() => bytes.subarray(at,Math.min(bytes.length,at + HASH_BYTES)));
  return new BlobType(readEach(parts));
}
async function pngReference(file,options,{journal},metadata = false) {
  const head = file.subarray(0,Math.min(file.length,32));
  if (![137,80,78,71,13,10,26,10].every((v,i) => head[i] === v)) return null;
  if (head.length < 24) throw fail('JXL_INPUT','The PNG header is incomplete.');
  const view = new DataView(head.buffer,head.byteOffset,head.byteLength);
  dimensions(view.getUint32(16),view.getUint32(20),options.maxPixels);
  return journal.tools.pngPixels(journal,file,{readAs:options.readAs,deep:true,orient:true,metadata,
    reader:{pngWalk,pngLayout,pngRows,pngPassRows,pngOrientationLocation,unfilterRow}});
}

export async function nativeReferenceInSteps(bytes,size,options,context) {
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
          {region:{x,y,width:w,height:h},platform:() => 'Pass RGBA pixels, a 16-bit or transparent PNG Blob, or use recompress.'});
        if (picture.width !== w || picture.height !== h) throw fail('JXL_PLATFORM','The native decoder returned the reference crop at the wrong size.');
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

export const verificationUnit = journal => async (name,run,flags = {}) => {
  const saved = await journal({unit:name,...flags});
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
      if (unknown) throw fail('JXL_OPTIONS',`A resumable verify takes result, parts and maxPixels; not ${unknown}.`);
      const result = object(options.result,'Stored result');
      if (Object.hasOwn(result,'bytes') || Object.hasOwn(result,'verification') || !isImageResult({...result,bytes:Uint8Array.of(0)}))
        throw fail('JXL_INPUT','A stored verification result is ImageResult metadata without bytes or a verification receipt.');
      const maxPixels = options.maxPixels === undefined && result.kept === 'jpeg-bytes' ? JPEG_PIXELS : pixelLimit(options.maxPixels,LARGEST);
      dimensions(result.width,result.height,maxPixels);
      const kind = source.kind ?? 'pixels';
      if (kind === 'pixels') {
        dimensions(source.width,source.height,maxPixels);
        if (source.byteLength !== source.width * source.height * 4)
          throw fail('JXL_INPUT','A resumable pixel source is straight RGBA8 rows: byteLength is width * height * 4.');
      } else if (kind !== 'file') throw fail('JXL_INPUT','A resumable verification source is pixels or a file.');
      if (!Array.isArray(options.parts) || !options.parts.length || options.parts.some(ref => !refOf(ref).length) ||
          options.parts.reduce((size,ref) => size + ref.length,0) > 0xffffffff)
        throw fail('JXL_INPUT','A stored candidate has a nonempty ordered list of immutable byte parts.');
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
    ...(ordinary && {async straight(plan,data,source,signal,part) {
      const pieces = [];
      for (const ref of plan.options.parts) pieces.push(await part(ref));
      const bytes = new Uint8Array(pieces.reduce((n,p) => n + p.length,0));
      let at = 0;
      for (const piece of pieces) { bytes.set(piece,at); at += piece.length; }
      const original = (source.kind ?? 'pixels') === 'file' ? data : {data,width:source.width,height:source.height,...(source.colorSpace && {colorSpace:source.colorSpace})};
      const facts = await ordinary(original,{...plan.options.result,bytes},{signal,maxPixels:plan.maxPixels});
      return {bytes:new Uint8Array(0),facts};
    }}),
    record(bytes,plan,source,facts) {
      if (bytes.length || facts?.verified !== true) throw fail('JXL_INPUT','The verification job has no completed receipt.');
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
  const steps = context.restoreSteps ?? restorationSteps();
  if (!steps?.open || !steps?.normalize) throw fail('JXL_UNSUPPORTED','Bounded JPEG verification needs rapier-jxl/jpeg\'s restore.');
  const maxPixels = Math.min(options.maxPixels,JPEG_PIXELS), plan = steps.normalize({maxPixels});
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

async function decodedGroups(bytes,options,{journal,unit,tools},hostOnly = false) {
  const {nativePictureWith,NATIVE_PICTURE_OPTIONS} = tools;
  const info = await drain(boundedHeaderSteps(bytes),journal);
  dimensions(info.width,info.height,options.maxPixels);
  if (info.animation) throw fail('JXL_UNSUPPORTED','Bounded verification requires a still image.');
  const {value:native} = await unit('verify-decode-reader',() => !hostOnly && nativeVerification(info,decodeOptions(options)));
  const opened = native ? null : await drain(verificationImageSteps(bytes,decodeOptions(options)),journal);
  const group = native ? GROUP : opened.group;
  if (![128,256,512,1024].includes(group)) throw fail('JXL_DECODE','The decoder returned an invalid physical group size.');
  const bands = [];
  let description, Type, blob;
  for (let y = 0; y < info.height; y += group) {
    const band = [];
    for (let x = 0; x < info.width; x += group) {
      const width = Math.min(group,info.width - x), height = Math.min(group,info.height - y);
      const {value} = await unit('verify-decode-group',async () => {
        const picture = native ? shown(info,await nativePictureWith(bytes.subarray(0,Math.min(bytes.length,32)),
          {width,height,colorSpace:info.colorEncoding.primaries,maxPixels:options.maxPixels,signal:options.signal},(makeBitmap,BlobType) => {
            blob ??= fileBlob(bytes,BlobType);
            return () => makeBitmap.call(globalThis,blob,x,y,width,height,NATIVE_PICTURE_OPTIONS);
          })) : await decodeGroupFile(bytes,{...decodeOptions(options),region:{x,y,width,height},
            maxTotalSamples:Math.max(1048576,GROUP * GROUP * 108)},opened);
        if (![Uint8Array,Uint8ClampedArray,Uint16Array,Float32Array].some(T => picture.data instanceof T) || picture.width !== width || picture.height !== height)
          throw fail('JXL_UNSUPPORTED','Bounded verification needs complete typed RGBA groups.');
        return {type:picture.data instanceof Uint16Array ? 'Uint16Array' : picture.data instanceof Float32Array ? 'Float32Array' : 'Uint8Array',
          data:new Uint8Array(picture.data.buffer,picture.data.byteOffset,picture.data.byteLength),description:Object.fromEntries(DECODE_FIELDS.filter(key => picture[key] !== undefined)
          .map(key => [key,key === 'extraChannels' ? picture[key].map(({data,plane,...channel}) => channel) : picture[key]]))};
      },{cold:true,alone:true});
      description ??= value.description;
      Type ??= {Uint8Array,Uint16Array,Float32Array}[value.type];
      band.push(value.data);
    }
    bands.push(band);
  }
  const size = Type.BYTES_PER_ELEMENT;
  return {...description,width:info.width,height:info.height,
    data:sampleView(tiledBytes(bands,info.width * size,info.height,group,group * size,journal.touched),Type)};
}

async function referenceInSteps(original,options,context) {
  if (context.reference) return context.reference;
  let picture = original;
  let orient = false;
  if ((context.source?.kind ?? 'pixels') === 'file') {
    const head = original.subarray(0,Math.min(original.length,32));
    if (isJXL(head)) picture = options.readAs === undefined ? fromDecoded(await decodedGroups(original,options,context))
      : await nativeReferenceInSteps(original,options.size,options,context);
    else if (head[0] === 255 && head[1] === 216 && options.readAs === undefined && ownJPEGReference()) {
      const steps = jpegReferenceSteps();
      if (!steps) throw fail('JXL_UNSUPPORTED','Bounded JPEG references here need configureDecoder(decode, restore) with rapier-jxl/jpeg\'s restore.');
      await steps.prepare?.();
      const encoded = await drain(steps.open(steps.normalize({effort:1,maxPixels:Math.min(options.maxPixels,JPEG_PIXELS)}),original),context.journal);
      picture = fromDecoded(await decodedGroups(encoded.bytes,options,context,true)); orient = true;
    }
    else { picture = await pngReference(original,options,context); orient = !!picture; }
    if (!picture) {
      if (head[0] === 255 && head[1] === 216 || [137,80,78,71,13,10,26,10].every((v,i) => head[i] === v))
        picture = await nativeReferenceInSteps(original,options.size,options,context);
      else throw fail('JXL_UNSUPPORTED','This source needs a bounded reference reader for verification.');
    }
  }
  if (orient || options.transform) picture = await orientInSteps(picture,context);
  if (options.transform) picture = await resizeInSteps(picture,options.transform.width,options.transform.height,options,context);
  return picture;
}

export async function pixelResultInSteps(bytes,original,{fidelity,format,size,outputDigest,details,options},context) {
  const {comparison,comparisonContext,pictureICC,conversionProfile,sameBytes,pixelEvidence,protectionDomain,protectionEvidence,
    describedIdentity,sampleBytes,profileTransformSteps} = context.tools;
  const unit = verificationUnit(context.journal), here = {...context,unit};
  const reference = await referenceInSteps(original,{...options,size},namedContext(here,'reference-'));
  const outputContext = namedContext(here,'output-');
  const decoded = format === 'jxl' ? await decodedGroups(bytes,options,outputContext)
    : await pngReference(bytes,{...options,readAs:undefined},outputContext);
  if (!decoded) throw fail('JXL_UNSUPPORTED','This output needs a bounded verification reader.');
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
    transform && !transform.gray ? transform : null,equalICC));
  const knownIdentity = reference === original ? context.sourceIdentity : null;
  let state = {compared:comparison({...reference,data:new reference.data.constructor(0)},{...decoded,data:new decoded.data.constructor(0)},options.protection,0,meaning),
    hash:knownIdentity ? null : sha256Start()};
  for (let y = 0; y < reference.height; y += ROWS) {
    const height = Math.min(ROWS,reference.height - y);
    const {value} = await unit('verify-compare-rows',() => {
      const [before,after] = readEach([reference,decoded].map(picture => () => ({...picture,height,
        data:picture.data.subarray(y * picture.width * 4,(y + height) * picture.width * 4)})));
      const measured = comparison(before,after,options.protection,y * reference.width,meaning), previous = state.compared;
      const compared = {...previous,...measured,exact:previous.exact && measured.exact,alphaExact:previous.alphaExact && measured.alphaExact,
        supported:previous.supported && measured.supported,maxError:Math.max(previous.maxError,measured.maxError),
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
  const evidence = protectionEvidence(await pixelEvidence(reference,decoded,fidelity,options,state.compared,
    (before,after,profile,encoding) => scoreInSteps(before,after,profile,encoding,here)),state.compared,options);
  check(options.signal);
  return {...displaySize(decoded),kept:evidence.kept,proof:{...evidence.proof,outputDigest,referenceDigest:referenceIdentity.digest,...details},
    fits:evidence.proof.verified,...(evidence.reason && {reason:evidence.reason})};
}
