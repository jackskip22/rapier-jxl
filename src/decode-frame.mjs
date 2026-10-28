// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {power2} from './decode-header.mjs';
import {readMATree, createModular} from './decode-modular.mjs';
import {readVarDCTGlobal, createVarDCT, restoreFilters} from './decode-vardct.mjs';

const floatBits = new DataView(new ArrayBuffer(4));
function mapSamples(data, map) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = map(data[i], i);
  return out;
}
function channelSamples(data, depth) {
  if (depth.float) return mapSamples(data, v => sampleValue(v, depth));
  const maximum = power2(depth.bits) - 1, out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / maximum;
  return out;
}
export function sampleValue(word, depth) {
  if (!depth.float) return word / (power2(depth.bits) - 1);
  if (depth.bits === 32 && depth.exponentBits === 8) { floatBits.setUint32(0,word>>>0); return floatBits.getFloat32(0); }
  const bits = depth.bits, eb = depth.exponentBits, mb = bits-eb-1, unit = power2(mb), signBit = power2(bits-1), bias = power2(eb-1)-1;
  const u = word>>>0, sign = u >= signBit ? -1 : 1, exponent = Math.floor(u/unit) % power2(eb), fraction = u % unit;
  if (exponent === power2(eb)-1) return fraction ? NaN : sign*Infinity;
  return sign*(exponent ? 1+fraction/unit : fraction/unit)*power2((exponent || 1)-bias);
}
export function jpegShifts(sample) {
  const hs=sample.map(v=>v===1||v===2?1:0),vs=sample.map(v=>v===1||v===3?1:0),mh=Math.max(...hs),mv=Math.max(...vs);
  return {hs:hs.map(v=>mh-v),vs:vs.map(v=>mv-v)};
}
export function decodeFrameSections(readers, h, f, {readFeatures, lfReference, maxSamples, maxModularWork, band = null} = {}) {
  const single = readers.length === 1, r=readers[0];
  const features = readFeatures ? readFeatures(r,h,f) : {};
  requireDecode(readFeatures || !(f.flags & 19n),'JPEG XL frame features need their reader.',r);
  const lfDequant = r.read(1) ? [1/32,1/4,1/2] : [r.f16(),r.f16(),r.f16()];
  requireDecode(lfDequant.every(v=>v>=1e-8),'Invalid JPEG XL LF dequantization.',r);
  const {hs,vs}=jpegShifts(f.jpegUpsampling), channels=[];
  if(f.modular) for(let c=0;c<f.encodedColorChannels;c++) channels.push({width:Math.ceil(f.encodedWidth/power2(hs[c])),height:Math.ceil(f.encodedHeight/power2(vs[c])),hshift:hs[c],vshift:vs[c]});
  for(let c=0;c<h.extraChannels.length;c++) {
    const factor=f.extraUpsampling[c]*power2(h.extraChannels[c].dimShift)/f.upsampling,shift=31-Math.clz32(factor);
    channels.push({width:Math.ceil(f.encodedWidth/factor),height:Math.ceil(f.encodedHeight/factor),hshift:shift,vshift:shift});
  }
  let sampleBudget = 0;
  for (const c of channels) {
    const samples = c.width * c.height;
    if (!Number.isSafeInteger(samples) || samples < 0 || sampleBudget > Number.MAX_SAFE_INTEGER - samples) { sampleBudget = 0; break; }
    sampleBudget += samples;
  }
  if (!f.modular) {
    const area = f.encodedWidth * f.encodedHeight * 3;
    if (Number.isSafeInteger(area) && area > sampleBudget) sampleBudget = area;
  }
  const maxTreeNodes = Math.min(1048576, 1024 + sampleBudget);
  const global = f.modular ? null : readVarDCTGlobal(r);
  const globalTree = r.read(1) ? readMATree(r, {maxNodes: maxTreeNodes}) : null;
  const modular=createModular(r,channels,{globalTree,groupDim:f.groupDim,bitDepth:h.bitDepth.bits,maxModularWork,...(maxSamples===undefined?{}:{maxSamples})});
  modular.decodeGlobal(r,0);
  const dct=f.modular?null:createVarDCT({width:f.encodedWidth,height:f.encodedHeight,header:f,global,lfDequant,bitDepth:h.bitDepth.bits,globalTree,imageHeader:h,maxModularWork,modularWork:modular.modularWork,band,maxSection:Math.max(...readers.map(x=>x.bytes.length))});
  if(!single)r.end();
  for(let g=0;g<f.numLFGroups;g++) {
    if(band){const y=Math.floor(g/f.lfGroupsX)*2048;if(y+2048<=band.first*256-16||y>=band.end*256+16)continue;}
    const rr=single?r:readers[1+g], readExtra=()=>modular.decodeGroup(rr,{x:g%f.lfGroupsX*f.groupDim*8,y:Math.floor(g/f.lfGroupsX)*f.groupDim*8,width:f.groupDim*8,height:f.groupDim*8,lf:true,streamIndex:1+f.numLFGroups+g});
    if(dct)dct.readLF(rr,g,{decodeExtraLF:readExtra});else readExtra();
    if(!single)rr.end();
  }
  const hf=single?r:readers[1+f.numLFGroups];
  if(dct)dct.readHFGlobal(hf);
  if(!single)hf.end();
  let maximum=3;
  for(let pass=0;pass<f.passes.count;pass++) {
    let minimum=maximum;const hint=f.passes.lastPass.indexOf(pass);
    if(hint>=0)minimum=31-Math.clz32(f.passes.downsample[hint]);
    if(pass===f.passes.count-1)minimum=0;
    for(let g=0;g<f.numGroups;g++) {
      if(band&&(Math.floor(g/dct.groupsX)<band.first||Math.floor(g/dct.groupsX)>=band.end))continue;
      const rr=single?r:readers[2+f.numLFGroups+pass*f.numGroups+g];
      if(dct)dct.readPassGroup(rr,g,pass);
      modular.decodeGroup(rr,{x:g%f.groupsX*f.groupDim,y:Math.floor(g/f.groupsX)*f.groupDim,width:f.groupDim,height:f.groupDim,minShift:minimum,maxShift:maximum,streamIndex:1+3*f.numLFGroups+17+pass*f.numGroups+g});
      if(!single)rr.end();
      if(dct&&pass===f.passes.count-1&&(g%dct.groupsX===dct.groupsX-1||g===f.numGroups-1))dct.renderRow(Math.floor(g/dct.groupsX),lfReference);
    }
    maximum=minimum;
  }
  if(single)r.end();
  if(band)return {dct,features};
  const decoded=modular.finish(),colorCount=f.modular?f.encodedColorChannels:0;
  const extraChannels=decoded.slice(colorCount).map((c,i)=>({...h.extraChannels[i],width:c.width,height:c.height,data:channelSamples(c.data,h.extraChannels[i].bitDepth)}));
  if(dct) return {...dct.render({lfReference}),width:f.encodedWidth,height:f.encodedHeight,extraChannels,features,global,lfDequant};
  let planes;
  if(h.xyb) {
    const [y,x,b]=decoded;
    planes=[mapSamples(x.data,v=>v*lfDequant[0]/128),mapSamples(y.data,v=>v*lfDequant[1]/128),mapSamples(b.data,(v,i)=>(v+y.data[i])*lfDequant[2]/128)];
  } else planes=decoded.slice(0,colorCount).map(c=>channelSamples(c.data,h.bitDepth));
  const widths=decoded.slice(0,colorCount).map(c=>c.width),heights=decoded.slice(0,colorCount).map(c=>c.height);
  return {planes,widths,heights,width:f.encodedWidth,height:f.encodedHeight,extraChannels,features,global,lfDequant,filtersApplied:false};
}

export function upsampleJPEG(plane, width, height, targetWidth, targetHeight) {
  if(width<targetWidth) {
    const out=new Float32Array(targetWidth*height);
    for(let y=0;y<height;y++) for(let x=0;x<targetWidth;x++) {
      const c=x>>1,neighbor=x&1?Math.min(c+1,width-1):Math.max(c-1,0);
      out[y*targetWidth+x]=(3*plane[y*width+c]+plane[y*width+neighbor])/4;
    }
    plane=out;width=targetWidth;
  }
  if(height<targetHeight) {
    const out=new Float32Array(width*targetHeight);
    for(let y=0;y<targetHeight;y++) {
      const c=y>>1,neighbor=y&1?Math.min(c+1,height-1):Math.max(c-1,0);
      for(let x=0;x<width;x++)out[y*width+x]=(3*plane[c*width+x]+plane[neighbor*width+x])/4;
    }
    plane=out;
  }
  return plane;
}
export function restoreFrame(frame,f) {
  if(f.ycbcr)frame.planes=frame.planes.map((p,c)=>upsampleJPEG(p,frame.widths[c],frame.heights[c],frame.width,frame.height));
  if(!frame.filtersApplied) {
    const gray=frame.planes.length===1,planes=gray?[frame.planes[0],frame.planes[0],frame.planes[0]]:frame.planes;
    const result=restoreFilters(planes,frame.width,frame.height,f.filter,frame.filterSigma);
    frame.planes=gray?[result[0]]:result;frame.filtersApplied=true;
  }
  frame.widths=frame.planes.map(()=>frame.width);frame.heights=frame.planes.map(()=>frame.height);
  return frame;
}
