// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {power2} from './decode-header.mjs';
import {readMATree, createModular} from './decode-modular.mjs';
import {readVarDCTGlobal, createVarDCT, restoreFilters} from './decode-vardct.mjs';
import {decodeKernels} from './decode-kernels.mjs';

function kernelSamples(runs, convert) {
  const kernels = decodeKernels(), total = runs[0].length, chunk = Math.max(1, Math.min(total, 1048576)), at = kernels.reserve(runs.map(() => chunk * 4));
  const out = runs.map(r => new Float32Array(r.buffer, r.byteOffset, r.length));
  for (let i = 0; i < total; i += chunk) {
    const n = Math.min(chunk, total - i);
    runs.forEach((r, k) => new Int32Array(kernels.buffer, at[k], n).set(r.subarray(i, i + n)));
    convert(n, at);
    out.forEach((o, k) => o.set(new Float32Array(kernels.buffer, at[k], n), i));
  }
  return out;
}
function channelSamples(data, depth) {
  const kernels = decodeKernels();
  return kernelSamples([data], (n, [at]) => kernels.samples(n, at, depth.float ? 1 : 0, depth.float ? 0 : power2(depth.bits) - 1, depth.bits, depth.exponentBits ?? 0))[0];
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
  if(!single)r.endSection();
  for(let g=0;g<f.numLFGroups;g++) {
    if(band){const y=Math.floor(g/f.lfGroupsX)*2048;if(y+2048<=band.first*256-16||y>=band.end*256+16)continue;}
    const rr=single?r:readers[1+g], readExtra=()=>modular.decodeGroup(rr,{x:g%f.lfGroupsX*f.groupDim*8,y:Math.floor(g/f.lfGroupsX)*f.groupDim*8,width:f.groupDim*8,height:f.groupDim*8,lf:true,streamIndex:1+f.numLFGroups+g});
    if(dct)dct.readLF(rr,g,{decodeExtraLF:readExtra});else readExtra();
    if(!single)rr.endSection();
  }
  const hf=single?r:readers[1+f.numLFGroups];
  if(dct)dct.readHFGlobal(hf);
  if(!single)hf.endSection();
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
      if(!single)rr.endSection();
      if(dct&&pass===f.passes.count-1&&(g%dct.groupsX===dct.groupsX-1||g===f.numGroups-1))dct.renderRow(Math.floor(g/dct.groupsX),lfReference);
    }
    maximum=minimum;
  }
  if(single)r.endSection();
  if(band)return {dct,features};
  const decoded=modular.finish(),colorCount=f.modular?f.encodedColorChannels:0;
  const rendered=dct?.render({lfReference});
  const extraChannels=decoded.slice(colorCount).map((c,i)=>({...h.extraChannels[i],width:c.width,height:c.height,data:channelSamples(c.data,h.extraChannels[i].bitDepth)}));
  if(dct) return {...rendered,width:f.encodedWidth,height:f.encodedHeight,extraChannels,features,global,lfDequant};
  let planes;
  if(h.xyb) {
    const [y,x,b]=decoded,kernels=decodeKernels();
    planes=kernelSamples([x.data,y.data,b.data],(n,[ax,ay,ab])=>kernels.xybSamples(n,ax,ay,ab,lfDequant[0],lfDequant[1],lfDequant[2]));
  } else planes=decoded.slice(0,colorCount).map(c=>channelSamples(c.data,h.bitDepth));
  const widths=decoded.slice(0,colorCount).map(c=>c.width),heights=decoded.slice(0,colorCount).map(c=>c.height);
  return {planes,widths,heights,width:f.encodedWidth,height:f.encodedHeight,extraChannels,features,global,lfDequant,filtersApplied:false};
}

export function upsampleJPEG(plane, width, height, targetWidth, targetHeight) {
  if(width>=targetWidth&&height>=targetHeight)return plane;
  const kernels=decodeKernels(),across=width<targetWidth,down=height<targetHeight,tw=across?targetWidth:width,th=down?targetHeight:height;
  const rows=Math.max(2,Math.min(th,Math.floor(1048576/tw))),held=down?(rows>>1)+3:rows;
  const [source,wide,stripe]=kernels.reserve([held*width*4,held*tw*4,rows*tw*4]),out=new Float32Array(tw*th);
  for(let t0=0;t0<th;t0+=rows) {
    const t1=Math.min(th,t0+rows),s0=down?Math.max(0,(t0>>1)-1):t0,s1=down?Math.min(height,((t1-1)>>1)+2):t1;
    new Float32Array(kernels.buffer,source,(s1-s0)*width).set(plane.subarray(s0*width,s1*width));
    if(across)kernels.jpegAcross(s1-s0,source,width,wide,tw);
    if(down)kernels.jpegDown(across?wide:source,tw,s0,height,stripe,t0,t1);
    out.set(new Float32Array(kernels.buffer,down?stripe:wide,(t1-t0)*tw),t0*tw);
  }
  return out;
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
