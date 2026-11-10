// SPDX-License-Identifier: MIT
import {decodeKernels} from './decode-kernels.mjs';
import {JxlBits,requireDecode,uint32View} from './decode-bits.mjs';
import {readDecodeImageHeader,readDecodeFrameHeader,readDecodeTOC,power2} from './decode-header.mjs';
import {decodeFrameSections,restoreFrame} from './decode-frame.mjs';
import {part,frameFeatures} from './decode-parts.mjs';
import {transformColor,convertOutputColor} from './decode-color.mjs';
import {composeFrame,orientFrame,rgbaPixels} from './decode-compose.mjs';
import {SIGNATURE,CODESTREAM,PARTIAL,BROB,FTYP,LEVEL} from './decode-tables.mjs';
import {readContainer,readContainerSteps} from './container-advanced.mjs';
import {canvasArea,misses,emptyFrame,cropFrame} from './decode-region.mjs';
import {cutPreview} from './decode-prefix.mjs';
import {iccProfileLimit,admitDecodedICC,admitDecodedICCSteps} from './decode-icc-admission.mjs';
import {journalTool,sliceBytes} from './step-journal.mjs';

export const DECODE_LIMITS=Object.freeze({maxPixels:64000000,maxDimension:65536,maxSamples:268435456,maxRetainedSamples:268435456,maxTotalSamples:536870912,maxModularWork:536870912,maxFrames:4096,maxBoxes:65536,maxMetadataBytes:67108864,maxInputBytes:1073741824,maxFeatureBytes:268435456,maxFeatureWork:268435456});
const fourCC=type=>String.fromCharCode(type>>>24,type>>>16&255,type>>>8&255,type&255);
function admitInput(bytes,limits) {
  requireDecode(bytes instanceof Uint8Array&&bytes.length>=2,'JPEG XL input is a Uint8Array containing a complete image.');
  requireDecode(bytes.length<=limits.maxInputBytes,'JPEG XL input exceeds the byte limit.');
  const prefix=bytes.subarray(0,Math.min(bytes.length,12));
  if(prefix[0]===255&&prefix[1]===10)return true;
  requireDecode(SIGNATURE.every((b,i)=>prefix[i]===b),'Invalid JPEG XL signature.');
  return false;
}
function storageNext(bytes,limits,state,view) {
  const at=state.at;
  requireDecode(++state.count<=limits.maxBoxes,'JPEG XL box count exceeds the limit.');
  requireDecode(bytes.length-at>=8,'Truncated JPEG XL box header.');
  const short=view.getUint32(at),type=view.getUint32(at+4),header=short===1?16:8;
  requireDecode(bytes.length-at>=header,'Truncated extended JPEG XL box header.');
  let length=short===1?view.getUint32(at+8)*4294967296+view.getUint32(at+12):short||bytes.length-at,repair=null;
  if(limits.partial&&(type===CODESTREAM||type===PARTIAL)&&Number.isSafeInteger(length)&&length>bytes.length-at&&bytes.length-at>header+(type===PARTIAL?4:0)){
    length=bytes.length-at;repair={at,short,type,header,length};
  }
  requireDecode(Number.isSafeInteger(length)&&length>=header&&length<=bytes.length-at,'Invalid JPEG XL box size.');
  if(type===FTYP)state.rawMetadata+=Math.max(0,length-header-12);
  else if(type!==LEVEL&&type!==CODESTREAM&&type!==PARTIAL)state.rawMetadata+=length-header;
  requireDecode(state.rawMetadata<=limits.maxMetadataBytes,'JPEG XL metadata exceeds the byte limit.');state.at+=length;
  return repair;
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
  const source=readContainer(bytes,{maxBytes:limits.maxInputBytes,maxBoxes:limits.maxBoxes}),metadata=[];let totalMetadata=0;
  for(const box of source.auxiliary) {
    const compressed=box.boxType==='brob';let type=box.boxType,data=box.data;
    if(compressed){type=fourCC(uint32View(data).getUint32(0));data=part('brotli').decompressBrotli(data.subarray(4),{maxOutput:limits.maxMetadataBytes-totalMetadata,dictionary:limits.dictionary});}
    totalMetadata+=data.length;requireDecode(totalMetadata<=limits.maxMetadataBytes,'JPEG XL metadata exceeds the byte limit.');
    metadata.push({type,data:compressed?data:data.slice(),compressed});
  }
  return {codestream:source.codestream,boxes:metadata,container:{level:source.level,minorVersion:source.minorVersion}};
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
  requireDecode(expandedWidth*expandedHeight*(f.encodedColorChannels+h.extraChannels.length)<=options.maxSamples,'JPEG XL expanded planes exceed the sample limit.');
}

function renderSections(readers,h,f,refs,lf,options,visibility,sharedFeatureWork) {
  admitExpanded(h,f,options);
  let frame=restoreFrame(decodeFrameSections(readers,h,f,{readFeatures:(r,h,f)=>frameFeatures(r,h,f,options,sharedFeatureWork),lfReference:lf[f.lfLevel],maxSamples:options.maxSamples,maxModularWork:options.maxModularWork}),f);
  const {patches,splines,noise,budget}=frame.features,correlation=frame.global?[frame.global.correlation.baseX,frame.global.correlation.baseB]:[0,1];
  if(patches){upsampleExtra(frame,f,h,true);part('features').applyPatches(frame,patches,refs,h,options,budget);}
  if(splines&&frame.planes.length===3)part('features').applySplines(frame,splines,{...options,correlation,level:h.level},budget);
  const width=Math.ceil(f.width/power2(3*f.lfLevel)),height=Math.ceil(f.height/power2(3*f.lfLevel));
  frame.planes=frame.planes.map(p=>upsamplePlane(p,frame.width,frame.height,f.upsampling,width,height,h.upsamplingWeights));
  if(patches)frame.extraChannels=frame.extraChannels.map(e=>({...e,width,height,data:upsamplePlane(e.data,e.width,e.height,f.upsampling,width,height,h.upsamplingWeights)}));
  else upsampleExtra(frame,f,h,false);
  frame.width=width;frame.height=height;frame.widths=frame.planes.map(()=>width);frame.heights=frame.planes.map(()=>height);
  if(noise&&frame.planes.length===3)part('features').applyNoise(frame,noise,{...options,...visibility,correlation,groupSize:f.groupDim},budget);
  frame.x0=f.x0;frame.y0=f.y0;frame.saveBeforeColorTransform=f.saveBeforeColorTransform;
  return frame;
}

function publicFrame(frame,h,f,options) {
  requireDecode(frame.width*frame.height*(frame.rgba?4+(options.planes?3:0):4+3+frame.extraChannels.length)<=options.maxSamples,'JPEG XL output exceeds the sample limit.');
  const format=outputFormat(h,options);
  const quantize=options.planes||options.unpremultiplyAlpha||options.renderSpotColors?0:format==='uint8'?255:format==='uint16'?65535:0;
  frame=convertOutputColor(frame,h,{colorSpace:options.colorSpace,quantize});
  if(options.applyOrientation)frame=orientFrame(frame,h.orientation);
  const nativeSpace=frame.colorEncoding.iccSpace;
  const rgbaFrame=frame.colorEncoding.space==='xyb'||nativeSpace&&nativeSpace!=='RGB '&&nativeSpace!=='GRAY'?convertOutputColor(frame,h,{colorSpace:'srgb'}):frame;
  const banded=frame.rgba?.format===format&&frame.rgba.planes.length===rgbaFrame.planes.length&&frame.rgba.planes.every((p,i)=>p===rgbaFrame.planes[i]);
  const data=banded?frame.rgba.data:rgbaPixels(rgbaFrame,format,options.unpremultiplyAlpha,options.renderSpotColors);
  return {width:frame.width,height:frame.height,data,format,planes:options.planes?frame.planes:[],extraChannels:frame.extraChannels,
    colorEncoding:frame.colorEncoding,icc:frame.icc??null,rgbaColorEncoding:rgbaFrame.colorEncoding,rgbaICC:rgbaFrame.icc??null,
    duration:f.duration,durationSeconds:h.animation?f.duration*h.animation.denominator/h.animation.numerator:0,
    timecode:f.timecode,name:f.name,alphaPremultiplied:!!frame.extraChannels.find(e=>e.type===0)?.associated&&!options.unpremultiplyAlpha};
}

const retainedSamples=frame=>frame?frame.planes.reduce((n,p)=>n+p.length,0)+frame.extraChannels.reduce((n,c)=>n+c.data.length,0)+(frame.data?.length??0):0;

export function decodeOptions(options) {
  requireDecode(options!==null&&typeof options==='object','JPEG XL decode options must be an object.');
  options={...DECODE_LIMITS,format:'auto',colorSpace:'original',applyOrientation:true,unpremultiplyAlpha:false,renderSpotColors:false,planes:false,...options};
  requireDecode(['auto','uint8','uint16','float32'].includes(options.format),'JPEG XL output format is auto, uint8, uint16 or float32.');
  requireDecode(typeof options.planes==='boolean','JPEG XL decode option planes is true or false.');
  for(const key of Object.keys(DECODE_LIMITS))requireDecode(Number.isSafeInteger(options[key])&&options[key]>0,'Invalid JPEG XL decoder limit: '+key+'.');
  return options;
}
export const outputFormat=(h,options)=>options.format==='auto'?(h.bitDepth.float||h.bitDepth.bits>16?'float32':h.bitDepth.bits>8?'uint16':'uint8'):options.format;

function openImage(bytes,options) {
  const input=unpackInput(bytes,options),r=new JxlBits(options.borrowed?sliceBytes(input.codestream,0):input.codestream,!!options.borrowed),h=readDecodeImageHeader(r,options);
  h.level=input.container?.level??5;
  if(h.colorEncoding.wantICC){
    const level=input.container?.level??5;
    h.icc=part('icc').readICC(r,{maxBytes:options.maxMetadataBytes,maxProfileBytes:iccProfileLimit(level,options.maxMetadataBytes)});
    admitDecodedICC(h.icc,h,level);
  }
  r.align();
  return {input,r,h};
}
export function* openImageSteps(bytes,options) {
  return yield* journalTool('openImage')(bytes,options,{admitInput,storageNext,repairedHeader,uint32View,
    readContainer,readContainerSteps,fourCC,part,requireDecode,JxlBits,readDecodeImageHeader,iccProfileLimit,admitDecodedICCSteps,
    readDecodeFrameHeader,readDecodeTOC});
}
function reopenImage(opened) {
  const {input,h,bit}=opened,r=new JxlBits(sliceBytes(input.codestream,0),true);r.bit=bit;
  return {input,h,r};
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
  requireDecode(h.width > 0 && h.height > 0 && h.width <= options.maxDimension &&
    h.height <= options.maxDimension && h.width * h.height <= options.maxPixels,
    'JPEG XL preview exceeds the pixel or dimension limit.');
}
export function admitPreview(h, f, options) {
  if (!f) return 0;
  admitPreviewSize(h, options);
  const expanded = frameSamples(h, f).expandedSamples, pixels = f.width * f.height;
  const output = pixels * (4 + h.extraChannels.length + (options.planes ? 3 : 0));
  requireDecode(expanded + output <= options.maxRetainedSamples,
    'JPEG XL preview exceeds the retained sample limit.');
  return expanded + pixels * 4;
}

export function referenceSlots() {
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
      slots[f.saveAsReference]={free:normal&&!f.saveBeforeColorTransform&&!keyframe};
    },
  };
}

function arrived(r,read){
  const at=r.bit;
  if(at>=r.bytes.length*8)return null;
  try{return read();}catch(error){if(r.bit>r.bytes.length*8||/^Truncated JPEG XL/.test(error?.message??''))return null;throw error;}
}

export const WHOLE_FRAME=Symbol.for('rapier-jxl.verify.whole-frame');
export function decodeImage(bytes,options,renderFrame=null,opened=null) {
  decodeKernels();
  const {input,r,h}=opened?reopenImage(opened):openImage(bytes,options),sharedFeatureWork={spent:0};
  const requireRegion=condition=>{if(options.borrowed&&!condition)throw Object.assign(new Error('This file needs whole-frame decoding; bounded verification cannot read its regions.'),{code:'JXL_UNSUPPORTED',[WHOLE_FRAME]:true});};
  requireRegion(!h.preview);
  const ph=h.preview?{...h,...h.preview,preview:null,animation:null}:null;
  if(ph)admitPreviewSize(ph,options);
  const pf=ph&&readDecodeFrameHeader(r,ph,options),pr=pf&&readDecodeTOC(r,pf);
  const area=options.region?canvasArea(h,options.region,options.applyOrientation):null,hc=area?{...h,width:area.width,height:area.height}:h;
  const start=r.bit;let totalSamples=pf?admitPreview(ph,pf,options):0,patched=false;
  requireDecode(totalSamples<=options.maxTotalSamples,'JPEG XL frames exceed the total sample limit.',r);
  const counted=referenceSlots(),heads=[];let cut=false;
  for(let index=0;;index++) {
    requireDecode(index<options.maxFrames,'JPEG XL frame count exceeds the limit.',r);
    const f=options.partial?arrived(r,()=>{const f=readDecodeFrameHeader(r,h,options);readDecodeTOC(r,f,true);return f;}):readDecodeFrameHeader(r,h,options);
    if(!f){cut=true;break;}
    if(!options.partial)readDecodeTOC(r,f);
    heads.push(f);
    const outside=area&&f.type!==1&&misses(f,area),{expandedSamples,canvasSamples}=frameSamples(hc,f,counted.inPlace(f));
    totalSamples+=(outside?0:expandedSamples)+canvasSamples;patched||=(f.flags&2n)!==0n||f.type===2;
    requireDecode(totalSamples<=options.maxTotalSamples,'JPEG XL frames exceed the total sample limit.',r);
    counted.after(f);
    if(f.cut){cut=true;break;}
    if(f.isLast)break;
  }
  if(cut){
    r.bit=start;
    const {frame,small,f,headers}=cutPreview(r,h,options,arrived,(readers,f)=>renderSections(readers,h,f,[],[],options,{visibleFrame:0,nonvisibleFrame:0},sharedFeatureWork));
    return decoded([publicFrame(frame,small,f,options)],null,h,input,options,headers,{partial:{scale:8}});
  }
  if(area&&patched){
    requireRegion(false);
    const whole=decodeImage(bytes,{...options,region:undefined},renderFrame);
    return {...cropFrame(whole,options.region),frames:whole.frames.map(frame=>cropFrame(frame,options.region))};
  }
  const stack=!area&&renderFrame?.stack?.(h,heads);
  r.bit=start;
  let preview=null;
  if(pf) {
    const decoded=renderSections(pr,ph,pf,[],[],options,{visibleFrame:0,nonvisibleFrame:0},sharedFeatureWork);
    preview=publicFrame(transformColor(decoded,ph,pf,{colorSpace:'original'}),ph,pf,options);
  }
  const references=new Array(4),lf=new Array(4),frames=[],frameHeaders=[];
  let visible=0,nonvisible=0,outputSamples=retainedSamples(preview);
  const slots=referenceSlots();
  for(let index=0;;index++) {
    requireDecode(index<options.maxFrames,'JPEG XL frame count exceeds the limit.',r);
    const f=readDecodeFrameHeader(r,h,options),readers=readDecodeTOC(r,f);frameHeaders.push(f);
    const inPlace=slots.inPlace(f);slots.after(f);
    const normal=f.type===0||f.type===3,keyframe=normal&&(f.isLast||f.duration!==0);
    const outside=area&&f.type!==1&&misses(f,area);
    const banded=!outside&&index===0&&renderFrame?.bandable?.(h,f),{expandedSamples,canvasSamples}=banded?{expandedSamples:0,canvasSamples:hc.width*hc.height*(4+(options.planes?3:0))}:{...frameSamples(hc,f,inPlace),...(outside&&{expandedSamples:0})};
    requireDecode(canvasSamples<=options.maxSamples,'JPEG XL canvas exceeds the sample limit.',r);
    const heldSamples=outputSamples+references.reduce((n,v)=>n+retainedSamples(v),0)+lf.reduce((n,v)=>n+retainedSamples(v),0);
    requireDecode(heldSamples+expandedSamples+canvasSamples<=options.maxRetainedSamples,'JPEG XL retained frames exceed the sample limit.',r);
    if(keyframe){visible++;nonvisible=0;}else nonvisible++;
    requireDecode(!f.useLFFrame||lf[f.lfLevel],'JPEG XL frame refers to a missing low-frequency frame.',r);
    if(stack){
      admitExpanded(h,f,options);stack.add(readers,f);
      if(f.isLast){frames.push(publicFrame(stack.frame(),h,f,options));break;}
      continue;
    }
    let frame=outside?emptyFrame(h,f):null;
    if(!outside&&(index===0||area)&&renderFrame){admitExpanded(h,f,options);
      frame=renderFrame(readers,h,f,input.codestream,area,index);}
    requireRegion(!area||outside||frame);
    frame??=renderSections(readers,h,f,references,lf,options,{visibleFrame:visible,nonvisibleFrame:nonvisible},sharedFeatureWork);
    if(f.type===1){lf[f.lfLevel-1]=frame;continue;}
    const canReference=!f.isLast&&(f.duration===0||f.saveAsReference!==0);
    const beforeColor=frame;
    frame=transformColor(frame,h,f,{colorSpace:'original',inPlace:!(canReference&&f.saveBeforeColorTransform)});
    if(normal)frame=composeFrame(frame,hc,area?{...f,...(frame.regional??{x0:f.x0-area.x,y0:f.y0-area.y})}:f,references,inPlace);
    if(canReference)references[f.saveAsReference]=f.saveBeforeColorTransform?beforeColor:{...frame,saveBeforeColorTransform:false};
    if(keyframe){const output=publicFrame(frame,hc,f,options);outputSamples+=retainedSamples(output);frames.push(output);}
    if(f.isLast)break;
  }
  requireDecode(frames.length>0,'JPEG XL image contains no display frame.');
  return decoded(frames,preview,h,input,options,frameHeaders);
}
const decoded=(frames,preview,h,input,options,headers,more)=>({...frames[0],frames,preview,orientation:h.orientation,orientationApplied:options.applyOrientation,
  animation:h.animation,boxes:input.boxes,exif:input.boxes.filter(b=>b.type==='Exif').map(b=>b.data),xmp:input.boxes.filter(b=>b.type==='xml ').map(b=>b.data),
  ...more,metadata:{...h,container:input.container,frames:headers}});
