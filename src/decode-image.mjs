// SPDX-License-Identifier: MIT
import {JxlBits,requireDecode} from './decode-bits.mjs';
import {readDecodeImageHeader,readDecodeFrameHeader,readDecodeTOC,power2} from './decode-header.mjs';
import {decodeFrameSections,restoreFrame} from './decode-frame.mjs';
import {part,frameFeatures} from './decode-parts.mjs';
import {transformColor,convertOutputColor} from './decode-color.mjs';
import {composeFrame,orientFrame,rgbaPixels} from './decode-compose.mjs';
import {SIGNATURE,CODESTREAM,PARTIAL,BROB,FTYP,LEVEL} from './decode-tables.mjs';
import {inspectContainer} from './decode-container.mjs';

export const DECODE_LIMITS=Object.freeze({maxPixels:64000000,maxDimension:65536,maxSamples:268435456,maxRetainedSamples:268435456,maxTotalSamples:536870912,maxModularWork:536870912,maxFrames:4096,maxBoxes:65536,maxMetadataBytes:67108864,maxInputBytes:1073741824,maxFeatureBytes:268435456,maxFeatureWork:268435456});
const fourCC=type=>String.fromCharCode(type>>>24,type>>>16&255,type>>>8&255,type&255);
function unpackInput(bytes,limits) {
  requireDecode(bytes instanceof Uint8Array&&bytes.length>=2,'JPEG XL input is a Uint8Array containing a complete image.');
  requireDecode(bytes.length<=limits.maxInputBytes,'JPEG XL input exceeds the byte limit.');
  if(bytes[0]===255&&bytes[1]===10)return {codestream:bytes,boxes:[],container:null};
  requireDecode(SIGNATURE.every((b,i)=>bytes[i]===b),'Invalid JPEG XL signature.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let count=0,rawMetadata=0;
  for(let at=12;at<bytes.length;) {
    requireDecode(++count<=limits.maxBoxes,'JPEG XL box count exceeds the limit.');
    requireDecode(bytes.length-at>=8,'Truncated JPEG XL box header.');
    const short=view.getUint32(at),type=view.getUint32(at+4),header=short===1?16:8;
    requireDecode(bytes.length-at>=header,'Truncated extended JPEG XL box header.');
    const length=short===1?view.getUint32(at+8)*4294967296+view.getUint32(at+12):short||bytes.length-at;
    requireDecode(Number.isSafeInteger(length)&&length>=header&&length<=bytes.length-at,'Invalid JPEG XL box size.');
    if(type!==FTYP&&type!==LEVEL&&type!==CODESTREAM&&type!==PARTIAL&&type!==BROB)rawMetadata+=length-header;
    requireDecode(rawMetadata<=limits.maxMetadataBytes,'JPEG XL metadata exceeds the byte limit.');at+=length;
  }
  const source=inspectContainer(bytes,{maxBytes:limits.maxInputBytes,maxBoxes:limits.maxBoxes}),metadata=[];let totalMetadata=0;
  for(const box of source.auxiliary) {
    const compressed=box.boxType==='brob';let type=box.boxType,data=box.data;
    if(compressed){type=fourCC(new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(0));data=part('brotli').decompressBrotli(data.subarray(4),{maxOutput:limits.maxMetadataBytes-totalMetadata,dictionary:limits.dictionary});}
    totalMetadata+=data.length;requireDecode(totalMetadata<=limits.maxMetadataBytes,'JPEG XL metadata exceeds the byte limit.');metadata.push({type,data,compressed});
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

function renderSections(readers,h,f,refs,lf,options,visibility) {
  admitExpanded(h,f,options);
  let frame=restoreFrame(decodeFrameSections(readers,h,f,{readFeatures:(r,h,f)=>frameFeatures(r,h,f,options),lfReference:lf[f.lfLevel],maxSamples:options.maxSamples,maxModularWork:options.maxModularWork}),f);
  const {patches,splines,noise}=frame.features,correlation=frame.global?[frame.global.correlation.baseX,frame.global.correlation.baseB]:[0,1];
  if(patches){upsampleExtra(frame,f,h,true);part('features').applyPatches(frame,patches,refs,h,options);}
  if(splines&&frame.planes.length===3)part('features').applySplines(frame,splines,{...options,correlation});
  const width=Math.ceil(f.width/power2(3*f.lfLevel)),height=Math.ceil(f.height/power2(3*f.lfLevel));
  frame.planes=frame.planes.map(p=>upsamplePlane(p,frame.width,frame.height,f.upsampling,width,height,h.upsamplingWeights));
  if(patches)frame.extraChannels=frame.extraChannels.map(e=>({...e,width,height,data:upsamplePlane(e.data,e.width,e.height,f.upsampling,width,height,h.upsamplingWeights)}));
  else upsampleExtra(frame,f,h,false);
  frame.width=width;frame.height=height;frame.widths=frame.planes.map(()=>width);frame.heights=frame.planes.map(()=>height);
  if(noise&&frame.planes.length===3)part('features').applyNoise(frame,noise,{...options,...visibility,correlation,groupSize:f.groupDim});
  frame.x0=f.x0;frame.y0=f.y0;frame.saveBeforeColorTransform=f.saveBeforeColorTransform;
  return frame;
}

function publicFrame(frame,h,f,options) {
  requireDecode(frame.width*frame.height*(4+3+frame.extraChannels.length)<=options.maxSamples,'JPEG XL output exceeds the sample limit.');
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
  const input=unpackInput(bytes,options),r=new JxlBits(input.codestream),h=readDecodeImageHeader(r,options);
  if(h.colorEncoding.wantICC)h.icc=part('icc').readICC(r,{maxBytes:options.maxMetadataBytes});
  r.align();
  return {input,r,h};
}
export function openFirstFrame(bytes,options) {
  const {r,h}=openImage(bytes,options),f=h.preview?null:readDecodeFrameHeader(r,h,options);
  return {h,f,readers:f&&readDecodeTOC(r,f)};
}

function frameSamples(h,f) {
  const normal=f.type===0||f.type===3,keyframe=normal&&(f.isLast||f.duration!==0);
  return {expandedSamples:Math.ceil(f.width/power2(3*f.lfLevel))*Math.ceil(f.height/power2(3*f.lfLevel))*(3+h.extraChannels.length),
    canvasSamples:normal?h.width*h.height*(3+h.extraChannels.length+(keyframe?4:0)):0};
}

export function decodeImage(bytes,options,renderFrame=null) {
  const {input,r,h}=openImage(bytes,options);
  const ph=h.preview?{...h,...h.preview,preview:null,animation:null}:null,pf=ph&&readDecodeFrameHeader(r,ph,options),pr=pf&&readDecodeTOC(r,pf);
  const start=r.bit;let totalSamples=pf?frameSamples(ph,pf).expandedSamples+pf.width*pf.height*4:0;
  requireDecode(totalSamples<=options.maxTotalSamples,'JPEG XL frames exceed the total sample limit.',r);
  for(let index=0;;index++) {
    requireDecode(index<options.maxFrames,'JPEG XL frame count exceeds the limit.',r);
    const f=readDecodeFrameHeader(r,h,options);readDecodeTOC(r,f);
    const {expandedSamples,canvasSamples}=frameSamples(h,f);totalSamples+=expandedSamples+canvasSamples;
    requireDecode(totalSamples<=options.maxTotalSamples,'JPEG XL frames exceed the total sample limit.',r);
    if(f.isLast)break;
  }
  r.bit=start;
  let preview=null;
  if(pf) {
    const decoded=renderSections(pr,ph,pf,[],[],options,{visibleFrame:0,nonvisibleFrame:0});
    preview=publicFrame(transformColor(decoded,ph,pf,{colorSpace:'original'}),ph,pf,options);
  }
  const references=new Array(4),lf=new Array(4),frames=[],frameHeaders=[];
  let visible=0,nonvisible=0,outputSamples=retainedSamples(preview);
  for(let index=0;;index++) {
    requireDecode(index<options.maxFrames,'JPEG XL frame count exceeds the limit.',r);
    const f=readDecodeFrameHeader(r,h,options),readers=readDecodeTOC(r,f);frameHeaders.push(f);
    const normal=f.type===0||f.type===3,keyframe=normal&&(f.isLast||f.duration!==0),{expandedSamples,canvasSamples}=frameSamples(h,f);
    requireDecode(canvasSamples<=options.maxSamples,'JPEG XL canvas exceeds the sample limit.',r);
    const heldSamples=outputSamples+references.reduce((n,v)=>n+retainedSamples(v),0)+lf.reduce((n,v)=>n+retainedSamples(v),0);
    requireDecode(heldSamples+expandedSamples+canvasSamples<=options.maxRetainedSamples,'JPEG XL retained frames exceed the sample limit.',r);
    if(keyframe){visible++;nonvisible=0;}else nonvisible++;
    requireDecode(!f.useLFFrame||lf[f.lfLevel],'JPEG XL frame refers to a missing low-frequency frame.',r);
    let frame=null;
    if(index===0&&renderFrame){admitExpanded(h,f,options);frame=renderFrame(readers,h,f);}
    frame??=renderSections(readers,h,f,references,lf,options,{visibleFrame:visible,nonvisibleFrame:nonvisible});
    if(f.type===1){lf[f.lfLevel-1]=frame;continue;}
    const canReference=!f.isLast&&(f.duration===0||f.saveAsReference!==0);
    const beforeColor=frame;
    frame=transformColor(frame,h,f,{colorSpace:'original',inPlace:!(canReference&&f.saveBeforeColorTransform)});
    if(normal)frame=composeFrame(frame,h,f,references);
    if(canReference)references[f.saveAsReference]=f.saveBeforeColorTransform?beforeColor:{...frame,saveBeforeColorTransform:false};
    if(keyframe){const output=publicFrame(frame,h,f,options);outputSamples+=retainedSamples(output);frames.push(output);}
    if(f.isLast)break;
  }
  requireDecode(frames.length>0,'JPEG XL image contains no display frame.');
  const first=frames[0],exif=input.boxes.filter(b=>b.type==='Exif').map(b=>b.data),xmp=input.boxes.filter(b=>b.type==='xml ').map(b=>b.data);
  return {...first,frames,preview,orientation:h.orientation,orientationApplied:options.applyOrientation,
    animation:h.animation,boxes:input.boxes,exif,xmp,metadata:{...h,container:input.container,frames:frameHeaders}};
}
