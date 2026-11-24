// SPDX-License-Identifier: MIT
import {decodeKernels} from './decode-kernels.mjs';
import {PIXELS} from './limits.mjs';
import {JxlBits,requireDecode,requireSize,uint32View,TRUNCATED} from './decode-bits.mjs';
import {readDecodeImageHeader,readDecodeFrameHeader,readDecodeTOC,power2} from './decode-header.mjs';
import {decodeFrameSections,restoreFrame} from './decode-frame.mjs';
import {part,frameFeatures} from './decode-parts.mjs';
import {transformColor,convertOutputColor,nativeEncoding,sameEncoding,targetEncoding,xybSrgbConstants,xybToRGBA8,materializePostColor} from './decode-color.mjs';
import {composeFrame,orientFrame,rgbaPixels,rgbaPixelsRects} from './decode-compose.mjs';
import {SIGNATURE,CODESTREAM,PARTIAL,BROB,FTYP,LEVEL} from './decode-tables.mjs';
import {readContainer,readContainerSteps} from './container-advanced.mjs';
import {canvasArea,misses,emptyFrame,cropFrame} from './decode-region.mjs';
import {cutPreview} from './decode-prefix.mjs';
import {iccProfileLimit,admitDecodedICC,admitDecodedICCSteps} from './decode-icc-admission.mjs';
import {journalTool,sliceBytes} from './step-journal.mjs';

const BYTES=Number.MAX_SAFE_INTEGER,SIDE=1073741824;
const ICC_BYTES=268435456;
export const DECODE_LIMITS=Object.freeze({maxPixels:PIXELS,maxDimension:SIDE,maxSamples:268435456,maxRetainedSamples:268435456,maxTotalSamples:536870912,maxModularWork:536870912,maxFrames:BYTES,maxBoxes:BYTES,maxMetadataBytes:BYTES,maxInputBytes:BYTES});
const fourCC=type=>String.fromCharCode(type>>>24,type>>>16&255,type>>>8&255,type&255);
function admitInput(bytes,limits) {
  requireDecode(bytes instanceof Uint8Array&&bytes.length>=2,'input: nonempty Uint8Array');
  requireDecode(bytes.length<=limits.maxInputBytes,'input: over maxInputBytes');
  const prefix=bytes.subarray(0,Math.min(bytes.length,12));
  if(prefix[0]===255&&prefix[1]===10)return true;
  requireDecode(SIGNATURE.every((b,i)=>prefix[i]===b),'signature');
  return false;
}
function storageNext(bytes,limits,state,view) {
  const at=state.at;
  requireDecode(++state.count<=limits.maxBoxes,'boxes: over maxBoxes');
  const drop=()=>{state.end=at;state.at=bytes.length;return null;};
  if(limits.partial&&at>12&&bytes.length-at<8)return drop();
  requireDecode(bytes.length-at>=8,'truncated box header',undefined,true);
  const short=view.getUint32(at),type=view.getUint32(at+4),header=short===1?16:8;
  if(limits.partial&&at>12&&bytes.length-at<header)return drop();
  requireDecode(bytes.length-at>=header,'truncated extended box header');
  let length=short===1?view.getUint32(at+8)*4294967296+view.getUint32(at+12):short||bytes.length-at,repair=null;
  if(limits.partial&&(type===CODESTREAM||type===PARTIAL)&&Number.isSafeInteger(length)&&length>bytes.length-at&&bytes.length-at>header+(type===PARTIAL?4:0)){
    length=bytes.length-at;repair={at,short,type,header,length};
  }else if(limits.partial&&at>12&&Number.isSafeInteger(length)&&length>bytes.length-at)return drop();
  if(limits.partial&&type===PARTIAL)state.lastPartial=!repair&&length>=header+4&&view.getUint32(at+header)<0x80000000?{at,short,type,header,length}:null;
  requireDecode(Number.isSafeInteger(length)&&length>=header&&length<=bytes.length-at,'box size');
  if(type===FTYP)state.rawMetadata+=Math.max(0,length-header-12);
  else if(type!==LEVEL&&type!==CODESTREAM&&type!==PARTIAL)state.rawMetadata+=length-header;
  requireDecode(state.rawMetadata<=limits.maxMetadataBytes,'metadata: over maxMetadataBytes');state.at+=length;
  return repair;
}
function cutEnd(state) {
  const cut=state.end!==undefined||state.lastPartial;
  return {end:state.end,last:cut?state.lastPartial??null:null};
}
function repairedHeader(bytes,{at,short,type,header,length}) {
  const out=bytes.subarray(at,at+header+(type===PARTIAL?4:0)).slice(),view=new DataView(out.buffer,out.byteOffset,out.byteLength);
  if(short===1){view.setUint32(8,Math.floor(length/4294967296));view.setUint32(12,length>>>0);}else view.setUint32(0,length);
  if(type===PARTIAL)view.setUint32(header,(view.getUint32(header)|0x80000000)>>>0);
  return out;
}
function unpackInput(bytes,limits) {
  if(admitInput(bytes,limits))return {codestream:bytes,boxes:[],container:null};
  const view=uint32View(bytes),state={at:12,count:0,rawMetadata:0};
  while(state.at<bytes.length) {
    const repair=storageNext(bytes,limits,state,view);
    if(repair){const header=repairedHeader(bytes,repair);bytes=bytes.slice();bytes.set(header,repair.at);}
  }
  const cut=cutEnd(state);
  if(cut.end!==undefined)bytes=bytes.subarray(0,cut.end);
  if(cut.last){const header=repairedHeader(bytes,cut.last);bytes=bytes.slice();bytes.set(header,cut.last.at);}
  const source=readContainer(bytes,{maxBytes:limits.maxInputBytes,maxBoxes:limits.maxBoxes}),metadata=[];let totalMetadata=0;
  for(const box of source.auxiliary) {
    const compressed=box.boxType==='brob';let type=box.boxType,data=box.data;
    if(compressed){type=fourCC(uint32View(data).getUint32(0));data=part('brotli').decompressBrotli(data.subarray(4),{maxOutput:limits.maxMetadataBytes-totalMetadata,dictionary:limits.dictionary});}
    totalMetadata+=data.length;requireDecode(totalMetadata<=limits.maxMetadataBytes,'metadata: over maxMetadataBytes');
    metadata.push({type,data:compressed?data:data.slice(),compressed});
  }
  return {codestream:source.codestream,boxes:metadata,container:{level:source.level,minorVersion:source.minorVersion}};
}

export function admitContainer(bytes,limits) {
  if(admitInput(bytes,limits))return;
  const view=uint32View(bytes),state={at:12,count:0,rawMetadata:0};
  while(state.at<bytes.length)storageNext(bytes,limits,state,view);
  readContainer(state.end===undefined?bytes:bytes.subarray(0,state.end),{maxBytes:limits.maxInputBytes,maxBoxes:limits.maxBoxes,borrowed:true});
}
const upsamplePlane=(input,width,height,factor,targetWidth,targetHeight,custom)=>factor===1&&width===targetWidth&&height===targetHeight?input:part('upsample').upsamplePlane(input,width,height,factor,targetWidth,targetHeight,custom);
function upsampleExtra(frame,f,h,toColor) {
  const width=toColor?frame.width:Math.ceil(f.width/power2(3*f.lfLevel)),height=toColor?frame.height:Math.ceil(f.height/power2(3*f.lfLevel));
  frame.extraChannels=frame.extraChannels.map((e,i)=>{
    const factor=toColor?f.extraUpsampling[i]*power2(e.dimShift)/f.upsampling:f.extraUpsampling[i]*power2(e.dimShift);
    const data=upsamplePlane(e.data,e.width,e.height,factor,width,height,h.upsamplingWeights);
    return {...e,width,height,data};
  });
  return frame;
}

function admitExpanded(h,f,options) {
  const expandedWidth=Math.ceil(f.width/power2(3*f.lfLevel)),expandedHeight=Math.ceil(f.height/power2(3*f.lfLevel));
  requireDecode(expandedWidth*expandedHeight*(f.encodedColorChannels+h.extraChannels.length)<=options.maxSamples,'planes: over maxSamples');
}

function renderSections(readers,h,f,refs,lf,options,visibility) {
  admitExpanded(h,f,options);
  let frame=restoreFrame(decodeFrameSections(readers,h,f,{readFeatures:frameFeatures,lfReference:lf[f.lfLevel],maxSamples:options.maxSamples,maxModularWork:options.maxModularWork}),f);
  const {patches,splines,noise}=frame.features,correlation=frame.global?[frame.global.correlation.baseX,frame.global.correlation.baseB]:[0,1];
  if(patches){upsampleExtra(frame,f,h,true);part('features').applyPatches(frame,patches,refs,h);}
  if(splines&&frame.planes.length===3)part('features').applySplines(frame,splines,{correlation,level:h.level});
  const width=Math.ceil(f.width/power2(3*f.lfLevel)),height=Math.ceil(f.height/power2(3*f.lfLevel));
  frame.planes=frame.planes.map(p=>upsamplePlane(p,frame.width,frame.height,f.upsampling,width,height,h.upsamplingWeights));
  if(patches)frame.extraChannels=frame.extraChannels.map(e=>({...e,width,height,data:upsamplePlane(e.data,e.width,e.height,f.upsampling,width,height,h.upsamplingWeights)}));
  else upsampleExtra(frame,f,h,false);
  frame.width=width;frame.height=height;frame.widths=frame.planes.map(()=>width);frame.heights=frame.planes.map(()=>height);
  if(noise&&!options.withoutNoise&&frame.planes.length===3)part('features').applyNoise(frame,noise,{...visibility,correlation,groupSize:f.groupDim});
  frame.x0=f.x0;frame.y0=f.y0;frame.saveBeforeColorTransform=f.saveBeforeColorTransform;
  return frame;
}

function frameRecord(width,height,data,format,planes,extraChannels,colorEncoding,icc,rgbaColorEncoding,rgbaICC,h,f,options) {
  return {width,height,data,format,planes:options.planes?planes:[],extraChannels,
    colorEncoding,icc:icc??null,rgbaColorEncoding,rgbaICC:rgbaICC??null,
    duration:f.duration,durationSeconds:h.animation?f.duration*h.animation.denominator/h.animation.numerator:0,
    timecode:f.timecode,name:f.name,alphaPremultiplied:!!extraChannels.find(e=>e.type===0)?.associated&&!options.unpremultiplyAlpha};
}

function publicFrame(frame,h,f,options) {
  requireDecode(frame.width*frame.height*(frame.rgba?4+(options.planes?3:0):4+3+frame.extraChannels.length)<=options.maxRetainedSamples,'output: over maxRetainedSamples');
  const format=outputFormat(h,options);
  const quantize=options.planes||options.unpremultiplyAlpha||options.renderSpotColors?0:format==='uint8'?255:format==='uint16'?65535:0;
  frame=convertOutputColor(frame,h,{colorSpace:options.colorSpace,quantize});
  if(options.applyOrientation)frame=orientFrame(frame,h.orientation);
  const nativeSpace=frame.colorEncoding.iccSpace;
  const rgbaFrame=frame.colorEncoding.space==='xyb'||nativeSpace&&nativeSpace!=='RGB '&&nativeSpace!=='GRAY'?convertOutputColor(frame,h,{colorSpace:'srgb'}):frame;
  const banded=frame.rgba?.format===format&&frame.rgba.planes.length===rgbaFrame.planes.length&&frame.rgba.planes.every((p,i)=>p===rgbaFrame.planes[i]);
  const first=rgbaFrame.planes[0],over=!banded&&f.isLast&&!options.planes&&format==='uint8'&&first.byteOffset===0&&first.buffer.byteLength===rgbaFrame.width*rgbaFrame.height*4&&
    !rgbaFrame.extraChannels.some(e=>e.data.buffer===first.buffer);
  const data=banded?frame.rgba.data:rgbaPixels(rgbaFrame,format,options.unpremultiplyAlpha,options.renderSpotColors,over?new Uint8Array(first.buffer):null);
  return frameRecord(frame.width,frame.height,data,format,frame.planes,frame.extraChannels,frame.colorEncoding,frame.icc,rgbaFrame.colorEncoding,rgbaFrame.icc,h,f,options);
}

const retainedSamples=frame=>frame?(frame.planes??frame.xybPlanes??[]).reduce((n,p)=>n+p.length,0)+frame.extraChannels.reduce((n,c)=>n+c.data.length,0)+(frame.data?.length??0):0;

const SCALED=['maxSamples','maxRetainedSamples','maxTotalSamples','maxModularWork'];
export function pictureCounters(pixels) {
  const scale=Math.max(1,(pixels+16*2*65536)*13/DECODE_LIMITS.maxRetainedSamples),out={};
  for(const key of ['maxSamples','maxRetainedSamples','maxTotalSamples'])out[key]=Math.min(Number.MAX_SAFE_INTEGER,Math.ceil(DECODE_LIMITS[key]*scale));
  out.maxSamples=Math.min(2147483647,out.maxSamples);
  out.maxModularWork=Math.min(Number.MAX_SAFE_INTEGER,Math.max(Math.ceil(DECODE_LIMITS.maxModularWork*scale),pixels*104));
  return out;
}
const FLOOR_PIXELS=268435456;
let floor=null;
function fitPicture(options,h) {
  if(!options.scaled?.length)return;
  const counters=pictureCounters(Math.max(FLOOR_PIXELS,Math.min(options.maxPixels,h.width*h.height)));
  for(const key of options.scaled)options[key]=Math.max(options[key],counters[key]);
  options.scaled=null;
}
export function decodeOptions(options) {
  requireDecode(options!==null&&typeof options==='object','options: object');
  const scaled=options.scaled===null?null:SCALED.filter(key=>options[key]===undefined);
  options={...DECODE_LIMITS,...(scaled?.length&&(floor??=pictureCounters(FLOOR_PIXELS))),scaled,format:'auto',colorSpace:'original',applyOrientation:true,unpremultiplyAlpha:false,renderSpotColors:false,planes:false,...options};
  requireDecode(['auto','uint8','uint16','float32'].includes(options.format),'format: auto, uint8, uint16 or float32');
  requireDecode(typeof options.planes==='boolean','planes: boolean');
  for(const key of Object.keys(DECODE_LIMITS))requireDecode(Number.isSafeInteger(options[key])&&options[key]>0,key+': positive integer');
  return options;
}
export const outputFormat=(h,options)=>options.format==='auto'?(h.bitDepth.float||h.bitDepth.bits>16?'float32':h.bitDepth.bits>8?'uint16':'uint8'):options.format;

function openImage(bytes,options) {
  const input=unpackInput(bytes,options),r=new JxlBits(options.borrowed?sliceBytes(input.codestream,0):input.codestream,!!(options.borrowed||options.ownedInput)),h=readDecodeImageHeader(r,options);
  fitPicture(options,h);
  h.level=input.container?.level??5;
  if(h.colorEncoding.wantICC){
    const level=input.container?.level??5;
    const iccBytes=Math.min(options.maxMetadataBytes,ICC_BYTES);h.icc=part('icc').readICC(r,{maxBytes:iccBytes,maxProfileBytes:iccProfileLimit(level,iccBytes)});
    admitDecodedICC(h.icc,h,level);
  }
  r.align();
  return {input,r,h};
}
export function* openImageSteps(bytes,options) {
  return yield* journalTool('openImage')(bytes,options,{admitInput,storageNext,repairedHeader,cutEnd,uint32View,
    readContainer,readContainerSteps,fourCC,part,requireDecode,JxlBits,readDecodeImageHeader,iccProfileLimit,admitDecodedICCSteps,
    readDecodeFrameHeader,readDecodeTOC});
}
function reopenImage(opened) {
  const {input,h,bit}=opened,r=new JxlBits(sliceBytes(input.codestream,0),true);r.bit=bit;
  return {input,h,r};
}
export function unreadAfterLastFrame(bytes,options) {
  const {input,r,h}=openImage(bytes,{...options,ownedInput:true});
  if(h.preview)readDecodeTOC(r,readDecodeFrameHeader(r,{...h,...h.preview,preview:null,animation:null},options),false,false);
  for(let index=0;;index++){
    requireDecode(index<options.maxFrames,'frames: over maxFrames',r);
    const f=readDecodeFrameHeader(r,h,options);readDecodeTOC(r,f,false,false);
    if(f.isLast)return input.codestream.length-f.end;
  }
}
export function openFirstFrame(bytes,options) {
  const {r,h}=openImage(bytes,options),f=h.preview?null:readDecodeFrameHeader(r,h,options);
  return {h,f,readers:f&&readDecodeTOC(r,f)};
}

function frameSamples(h,f,inPlace=false) {
  const normal=f.type===0||f.type===3,keyframe=normal&&(f.isLast||f.duration!==0);
  return {expandedSamples:Math.ceil(f.width/power2(3*f.lfLevel))*Math.ceil(f.height/power2(3*f.lfLevel))*(3+h.extraChannels.length),
    canvasSamples:normal?h.width*h.height*(3+h.extraChannels.length+(keyframe?4:0))-(inPlace?h.width*h.height*(3+h.extraChannels.length):0):0};
}

export function admitPreviewSize(h, options) {
  requireDecode(h.width > 0 && h.height > 0, 'preview size');
  requireSize(h.width <= options.maxDimension && h.height <= options.maxDimension && h.width * h.height <= options.maxPixels,
    `preview ${h.width} x ${h.height}: over maxPixels or maxDimension`);
}
export function admitPreview(h, f, options) {
  if (!f) return 0;
  admitPreviewSize(h, options);
  const expanded = frameSamples(h, f).expandedSamples, pixels = f.width * f.height;
  const output = pixels * (4 + h.extraChannels.length + (options.planes ? 3 : 0));
  requireDecode(expanded + output <= options.maxRetainedSamples,
    'preview: over maxRetainedSamples');
  return expanded + pixels * 4;
}

export function referenceSlots(shareShown=true) {
  const slots=new Array(4).fill(null);
  return {
    inPlace(f) {
      const normal=f.type===0||f.type===3,source=f.blending?.[0]?.source;
      const mode=f.blending?.[0]?.mode;
      if(!normal||(mode!==0&&mode!==2)||f.blending.some(b=>b.mode!==mode||b.source!==source)||!slots[source]?.free)return false;
      const canReference=!f.isLast&&(f.duration===0||f.saveAsReference!==0);
      return canReference?f.saveAsReference===source&&!f.saveBeforeColorTransform:f.isLast;
    },
    after(f) {
      const normal=f.type===0||f.type===3,keyframe=normal&&(f.isLast||f.duration!==0);
      if(f.type===1||f.isLast||!(f.duration===0||f.saveAsReference!==0))return;
      slots[f.saveAsReference]={free:normal&&!f.saveBeforeColorTransform&&!(shareShown&&keyframe)};
    },
  };
}

function arrived(r,read){
  const at=r.bit;
  if(at>=r.bytes.length*8)return null;
  try{return read();}catch(error){if(r.bit>r.bytes.length*8||error?.[TRUNCATED]===true)return null;throw error;}
}

export const WHOLE_FRAME=Symbol.for('rapier-jxl.verify.whole-frame');
export function decodeImage(...args) {
  const steps=decodeImageSteps(...args);
  for(;;){const step=steps.next();if(step.done)return step.value;args[1].onFrame?.(...step.value);}
}

export function* decodeImageSteps(bytes,options,renderFrame=null,opened=null) {
  decodeKernels();
  const {input,r,h}=opened?reopenImage(opened):openImage(bytes,options);
  fitPicture(options,h);
  const requireRegion=condition=>{if(options.borrowed&&!condition)throw Object.assign(new Error('region decode: needs whole frame'),{code:'JXL_UNSUPPORTED',[WHOLE_FRAME]:true});};
  requireRegion(!h.preview);
  const ph=h.preview?{...h,...h.preview,preview:null,animation:null}:null;
  if(ph)admitPreviewSize(ph,options);
  const pf=ph&&readDecodeFrameHeader(r,ph,options),pr=pf&&readDecodeTOC(r,pf);
  const area=options.region?canvasArea(h,options.region,options.applyOrientation):null,hc=area?{...h,width:area.width,height:area.height}:h;
  const start=r.bit,previewCost=pf?admitPreview(ph,pf,options):0;
  requireSize(previewCost<=options.maxTotalSamples,'frames: over total sample limit');
  const streamFrames=!!(options.onFrame&&h.animation&&!options.partial&&!area&&!options.callerTotalSamples);
  let stack=null;
  if(!streamFrames) {
    let totalSamples=previewCost,patched=false,cut=false;
    const counted=referenceSlots(),heads=[];
    for(let index=0;;index++) {
      requireDecode(index<options.maxFrames,'frames: over maxFrames',r);
      const f=options.partial?arrived(r,()=>{const f=readDecodeFrameHeader(r,h,options);readDecodeTOC(r,f,true,false);return f;}):readDecodeFrameHeader(r,h,options);
      if(!f){cut=true;break;}
      if(!options.partial)readDecodeTOC(r,f,false,false);
      heads.push(f);
      const outside=area&&f.type!==1&&misses(f,area),{expandedSamples,canvasSamples}=frameSamples(hc,f,counted.inPlace(f));
      totalSamples+=(outside?0:expandedSamples)+canvasSamples;patched||=(f.flags&2n)!==0n||f.type===2;
      requireSize(totalSamples<=options.maxTotalSamples,'frames: over total sample limit');
      counted.after(f);
      if(f.cut){cut=true;break;}
      if(f.isLast)break;
      if(options.onFrame&&!options.callerTotalSamples&&(f.type===0||f.type===3)&&f.duration!==0)totalSamples=0;
    }
    if(cut){
      r.bit=start;
      const {frame,small,f,headers,partialInfo}=cutPreview(r,h,options,arrived,(readers,f)=>renderSections(readers,h,f,[],[],options,{visibleFrame:0,nonvisibleFrame:0}));
      return decoded([publicFrame(frame,small,f,options)],null,h,input,options,headers,{partial:partialInfo??{scale:8}});
    }
    if(area&&patched){
      requireRegion(false);
      const whole=decodeImage(bytes,{...options,region:undefined},renderFrame);
      return {...cropFrame(whole,options.region),frames:whole.frames.map(frame=>cropFrame(frame,options.region))};
    }
    stack=!area&&renderFrame?.stack?.(h,heads);
    r.bit=start;
  }
  let preview=null;
  if(pf) {
    const decoded=renderSections(pr,ph,pf,[],[],options,{visibleFrame:0,nonvisibleFrame:0});
    preview=publicFrame(transformColor(decoded,ph,pf,{colorSpace:'original'}),ph,pf,options);
  }
  const references=new Array(4),lf=new Array(4),frames=[],frameHeaders=[];
  let visible=0,nonvisible=0,outputSamples=retainedSamples(preview),windowSamples=previewCost;
  let shown=0;
  const shareShown=options.planes||(h.extraChannels.length>0&&!options.onFrame);
  const keep=output=>{if(options.onFrame&&frames.length)return;outputSamples+=retainedSamples(output);frames.push(output);};
  const slots=referenceSlots(shareShown),counted=streamFrames?referenceSlots():null;
  const format=outputFormat(hc,options),original=nativeEncoding(hc);
  const fastRGBA8=!area&&!options.planes&&format==='uint8'&&!options.unpremultiplyAlpha&&!options.renderSpotColors&&
    (!options.applyOrientation||hc.orientation===1)&&!original.wantICC&&
    (original.space==='rgb'||original.space==='gray')&&
    (!hc.xyb||original.space==='rgb'&&(original.transferFunction??(original.gamma===undefined?'srgb':'gamma'))==='srgb')&&
    (options.colorSpace==='original'||typeof options.colorSpace==='string'&&options.colorSpace!=='xyb'&&sameEncoding(original,targetEncoding(options.colorSpace)));
  const fastXYB=fastRGBA8&&hc.xyb&&hc.extraChannels.length===0;
  const xybConsts=fastXYB?xybSrgbConstants(hc,original):null;
  const emitShown=output=>{
    if(options.onFrame&&!frames.length&&output.extraChannels.length&&!options.planes)
      output={...output,extraChannels:output.extraChannels.map(e=>({...e,data:e.data.slice()}))};
    keep(output);
    return output;
  };
  for(let index=0;;index++) {
    requireDecode(index<options.maxFrames,'frames: over maxFrames',r);
    const f=readDecodeFrameHeader(r,h,options),readers=readDecodeTOC(r,f);
    if(!options.onFrame)frameHeaders.push(f);
    if(streamFrames) {
      const cost=frameSamples(hc,f,counted.inPlace(f));
      windowSamples+=cost.expandedSamples+cost.canvasSamples;
      requireSize(windowSamples<=options.maxTotalSamples,'frames: over total sample limit');
      counted.after(f);
    }
    const inPlace=slots.inPlace(f);slots.after(f);
    const normal=f.type===0||f.type===3,keyframe=normal&&(f.isLast||f.duration!==0);
    const outside=area&&f.type!==1&&misses(f,area);
    const banded=!outside&&!area&&renderFrame?.bandable?.(h,f),{expandedSamples,canvasSamples}=banded?{expandedSamples:0,canvasSamples:hc.width*hc.height*(4+(options.planes?3:0))}:{...frameSamples(hc,f,inPlace),...(outside&&{expandedSamples:0})};
    requireSize(canvasSamples<=options.maxSamples,'canvas: over maxSamples');
    const heldSamples=outputSamples+references.reduce((n,v)=>n+retainedSamples(v),0)+lf.reduce((n,v)=>n+retainedSamples(v),0);
    requireSize(heldSamples+expandedSamples+canvasSamples<=options.maxRetainedSamples,'retained frames: over maxRetainedSamples');
    if(keyframe){visible++;nonvisible=0;}else nonvisible++;
    requireDecode(!f.useLFFrame||lf[f.lfLevel],'missing LF frame',r);
    if(stack){
      admitExpanded(h,f,options);stack.add(readers,f);
      if(f.isLast){const output=emitShown(publicFrame(stack.frame(),h,f,options));if(options.onFrame)yield [output,shown++];break;}
      continue;
    }
    let frame=outside?emptyFrame(h,f):null;
    if(!outside&&(banded||area)&&renderFrame){
      admitExpanded(h,f,options);
      frame=renderFrame(readers,h,f,input.codestream,area,index);
    }
    requireRegion(!area||outside||frame);
    frame??=renderSections(readers,h,f,references,lf,options,{visibleFrame:visible,nonvisibleFrame:nonvisible});
    if(f.type===1){lf[f.lfLevel-1]=frame;continue;}
    if(!area&&frame.rgba) {
      const output=emitShown(publicFrame(frame,hc,f,options));
      if(options.onFrame){yield [output,shown++];windowSamples=0;}
      if(f.isLast)break;
      continue;
    }
    const canReference=!f.isLast&&(f.duration===0||f.saveAsReference!==0);
    const beforeColor=canReference&&f.saveBeforeColorTransform?frame:null;
    if(!normal&&f.saveBeforeColorTransform) {
      if(canReference)references[f.saveAsReference]=beforeColor;
      if(f.isLast)break;
      continue;
    }
    if(fastXYB&&!f.ycbcr&&normal) {
      const covers=f.blending[0].mode===0&&f.x0<=0&&f.y0<=0&&f.x0+frame.width>=hc.width&&f.y0+frame.height>=hc.height;
      if(covers) {
        requireDecode(hc.width*hc.height*7<=options.maxRetainedSamples,'output: over maxRetainedSamples');
        if(f.saveBeforeColorTransform||!canReference) {
          if(canReference)references[f.saveAsReference]=beforeColor;
          if(keyframe) {
            const first=frame.planes[0],over=!canReference&&f.isLast&&f.x0===0&&f.y0===0&&frame.width===hc.width&&frame.height===hc.height&&first.byteOffset===0&&first.buffer.byteLength===hc.width*hc.height*4;
            const data=over?new Uint8Array(first.buffer):new Uint8Array(hc.width*hc.height*4);
            xybToRGBA8(frame.planes,frame.width,-f.x0,-f.y0,hc.width,hc.height,hc,data,hc.width,0,0,xybConsts);
            const output=emitShown(frameRecord(hc.width,hc.height,data,'uint8',[],[],original,null,original,null,hc,f,options));
            if(options.onFrame){yield [output,shown++];windowSamples=0;}
          }
          if(f.isLast)break;
          continue;
        }
        let xybPlanes=frame.planes;
        if(f.x0!==0||f.y0!==0||frame.width!==hc.width||frame.height!==hc.height) {
          xybPlanes=[0,1,2].map(c=>{
            const dst=new Float32Array(hc.width*hc.height),src=frame.planes[c];
            for(let y=0;y<hc.height;y++)dst.set(src.subarray((y-f.y0)*frame.width-f.x0,(y-f.y0)*frame.width-f.x0+hc.width),y*hc.width);
            return dst;
          });
        }
        const prev=inPlace?references[f.blending[0].source]?.rgba8:null;
        const canvasRGBA=prev?.length===hc.width*hc.height*4?prev:new Uint8Array(hc.width*hc.height*4);
        xybToRGBA8(xybPlanes,hc.width,0,0,hc.width,hc.height,hc,canvasRGBA,hc.width,0,0,xybConsts);
        references[f.saveAsReference]={width:hc.width,height:hc.height,widths:[hc.width,hc.width,hc.width],heights:[hc.height,hc.height,hc.height],x0:0,y0:0,
          planes:null,xybPlanes,rgba8:canvasRGBA,extraChannels:[],colorEncoding:original,icc:null,ctDone:true,saveBeforeColorTransform:false};
        if(keyframe) {
          const output=emitShown(frameRecord(hc.width,hc.height,canvasRGBA.slice(),'uint8',[],[],original,null,original,null,hc,f,options));
          if(options.onFrame){yield [output,shown++];windowSamples=0;}
        }
        if(f.isLast)break;
        continue;
      }
      if(f.blending[0].mode===0&&inPlace&&references[f.blending[0].source]?.xybPlanes) {
        const ref=references[f.blending[0].source];
        const x0=Math.max(0,f.x0),y0=Math.max(0,f.y0),x1=Math.min(hc.width,f.x0+frame.width),y1=Math.min(hc.height,f.y0+frame.height),cw=x1-x0,ch=y1-y0;
        if(cw>0&&ch>0) {
          if(canReference) {
            for(let c=0;c<3;c++) {
              const src=frame.planes[c],dst=ref.xybPlanes[c],fw=frame.width;
              if(f.x0===0&&fw===hc.width&&cw===hc.width)dst.set(src.subarray((y0-f.y0)*fw,(y1-f.y0)*fw),y0*hc.width);
              else for(let y=y0;y<y1;y++)dst.set(src.subarray((y-f.y0)*fw+x0-f.x0,(y-f.y0)*fw+x1-f.x0),y*hc.width+x0);
            }
          }
          xybToRGBA8(frame.planes,frame.width,x0-f.x0,y0-f.y0,cw,ch,hc,ref.rgba8,hc.width,x0,y0,xybConsts);
        }
        if(keyframe) {
          requireDecode(hc.width*hc.height*7<=options.maxRetainedSamples,'output: over maxRetainedSamples');
          const data=f.isLast?ref.rgba8:ref.rgba8.slice();
          if(f.isLast)ref.rgba8=null;
          const output=emitShown(frameRecord(hc.width,hc.height,data,'uint8',[],[],original,null,original,null,hc,f,options));
          if(options.onFrame){yield [output,shown++];windowSamples=0;}
        }
        if(f.isLast)break;
        continue;
      }
    }
    if(normal)for(const b of f.blending)if(references[b.source])materializePostColor(references[b.source],hc);
    frame=transformColor(frame,h,f,{colorSpace:'original',inPlace:!(canReference&&f.saveBeforeColorTransform)});
    const cropW=frame.width,cropH=frame.height,prevRef=fastRGBA8&&!hc.xyb&&normal&&inPlace?references[f.blending[0].source]:null,prevRGBA=prevRef?.rgba8??null;
    const prevDirty=prevRef?.dirty??null;
    if(normal)frame=composeFrame(frame,hc,area?{...f,...(frame.regional??{x0:f.x0-area.x,y0:f.y0-area.y})}:f,references,inPlace,!canReference);
    if(fastRGBA8&&!hc.xyb&&normal&&(prevRGBA||canReference&&!f.saveBeforeColorTransform)) {
      let canvasRGBA=prevRGBA,dirty=prevDirty;
      if(canvasRGBA) {
        const x0=Math.max(0,f.x0),y0=Math.max(0,f.y0),x1=Math.min(hc.width,f.x0+cropW),y1=Math.min(hc.height,f.y0+cropH),rw=x1-x0,rh=y1-y0;
        if(dirty==='all'||x0===0&&y0===0&&rw===hc.width&&rh===hc.height)dirty='all';
        else if(rw>0&&rh>0) {
          dirty=dirty?[...dirty,[x0,y0,rw,rh]]:[[x0,y0,rw,rh]];
          let sum=0;for(let k=0;k<dirty.length;k++)sum+=dirty[k][2]*dirty[k][3];
          if(sum>=hc.width*hc.height)dirty='all';
        } else dirty??=[];
      } else if(keyframe) {
        canvasRGBA=rgbaPixels(frame,'uint8',false,false,null);dirty=[];
      } else {
        canvasRGBA=new Uint8Array(frame.width*frame.height*4);dirty='all';
      }
      if(keyframe) {
        if(dirty==='all'){rgbaPixels(frame,'uint8',false,false,canvasRGBA);dirty=[];}
        else if(dirty?.length){rgbaPixelsRects(frame,dirty,canvasRGBA);dirty=[];}
        requireDecode(frame.width*frame.height*(7+frame.extraChannels.length)<=options.maxRetainedSamples,'output: over maxRetainedSamples');
        const data=!canReference?canvasRGBA:canvasRGBA.slice();
        if(!canReference&&prevRef)prevRef.rgba8=null;
        const output=emitShown(frameRecord(frame.width,frame.height,data,'uint8',frame.planes,frame.extraChannels,frame.colorEncoding,frame.icc,frame.colorEncoding,frame.icc,hc,f,options));
        if(options.onFrame){yield [output,shown++];windowSamples=0;}
      }
      if(canReference)references[f.saveAsReference]={...frame,rgba8:canvasRGBA,dirty,saveBeforeColorTransform:false};
      if(f.isLast)break;
      continue;
    }
    if(canReference)references[f.saveAsReference]=f.saveBeforeColorTransform?beforeColor:{...frame,saveBeforeColorTransform:false};
    if(keyframe){const output=emitShown(publicFrame(frame,hc,f,options));if(options.onFrame){yield [output,shown++];windowSamples=0;}}
    if(f.isLast)break;
  }
  requireDecode(frames.length>0,'no display frame');
  return decoded(frames,preview,h,input,options,frameHeaders);
}

const decoded=(frames,preview,h,input,options,headers,more)=>({...frames[0],frames,preview,orientation:h.orientation,orientationApplied:options.applyOrientation,
  animation:h.animation,boxes:input.boxes,exif:input.boxes.filter(b=>b.type==='Exif').map(b=>b.data),xmp:input.boxes.filter(b=>b.type==='xml ').map(b=>b.data),
  ...more,metadata:{...h,container:input.container,frames:headers}});
