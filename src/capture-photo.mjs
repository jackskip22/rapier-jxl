// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {GRADIENT} from './screen-gradient-regions.mjs';
import {captureSmoothRegions} from './capture-smooth.mjs';
import {smoothQuantize} from './capture-smooth-quantize.mjs';
import {pagePalette} from './capture-page-palette.mjs';
import {gradientPageLayers} from './capture-gradient-page.mjs';
const PAGE_PALETTES=new WeakMap();
import {admitOptions, admitPixels, admitOutputSize, fault} from './admit.mjs';
import {encodeCaptureSteps, encodeCaptureBytes, captureBandSteps, captureCompareLevel, captureExact, markCaptureExact, CAPTURE_LEVEL, CAPTURE_BASE, CAPTURE_FLOOR, CAPTURE_SMALL_FLOOR, CAPTURE_PATCHES, CAPTURE_TOOLS, CAPTURE_TRACE, CAPTURE_HELPERS, CAPTURE_GPU, DEFAULT_EFFORT} from './capture-codec.mjs';
import {photoKernels, captureMergePhotoHints, captureBoxBound, captureFillUnder, captureTextDiff, captureUnionExact, captureProtectedBoxes} from './capture-kernels.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {writeImage} from './photo-image-write.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {lowWholePhotoSteps} from './photo-low.mjs';
import {flatSamples} from './screen-samples.mjs';
import {viewPixels} from './screen-crop.mjs';
import {screenPhotoRegions, screenPhotoTiles, drawnRegion, photoCells, photoCellText} from './screen-photo-regions.mjs';
import {hiddenColor, paletteKind, flattenGutter} from './screen-photo-kernels.mjs';
import {expandPhotoRegions} from './screen-photo-borders.mjs';
import {photoMasks, releasePhotoMasks, fillHoles, maskComponents} from './screen-photo-mask.mjs';
import {lossyModularFrame, lossyModularSections, lossyModularLength} from './capture-modular-lossy.mjs';
import {patchedPageSteps, protectedPageBoxes} from './capture-patched.mjs';
import {photoTextLayers} from './photo-text-layers.mjs';
import {findText} from './v7/letters-found.mjs';
import {CAPTURE_PROTECTION} from './capture-protection.mjs';
import {CAPTURE_FACTS} from './v7/capture-facts.mjs';
import {BANDED_LIMITS} from './memory-device.mjs';
import {unit} from './step-journal.mjs';
import {MEASURED_EFFORT} from './effort-level.mjs';
import {PAGE_MARGIN} from './v7/page-margin.mjs';
import {lettersFound} from './v7/letters-found.mjs';
import {smallPicture} from './photo-v6-settings.mjs';

const CLUSTER = 1.2;
export const UNION_CAP = Infinity;
const WHOLE = 0.85, SMALL = 2000000;
const MERGE_HINTS = 64;
const check = signal => { if (signal?.aborted) throw signal.reason; };
function* within(steps,from,span){
  let step,reply;
  try{
    while(!(step=steps.next(reply)).done)reply=yield typeof step.value==='number'?from+span*step.value:step.value;
    return step.value;
  }finally{steps.return?.();}
}

const covers = (regions,width,height) => regions.length===1&&regions[0].width*regions[0].height>=WHOLE*width*height;
const STRIPS = 8, dense = (bytes,pixels) => bytes*8>=pixels*6;
function* stripBytes(data,width,height,options,from){
  const count=Math.min(STRIPS,height>>5);let bytes=0;
  for(let i=0;i<count;i++){
    const y=Math.floor(i*(height-32)/Math.max(1,count-1));
    bytes+=(yield* within(encodeCaptureSteps(data.subarray(y*width*4,(y+32)*width*4),width,32,options),from,0)).length;
  }
  return {bytes,pixels:count*32*width};
}
function* denseStrips(data,width,height,options,from){
  const {bytes,pixels}=yield* stripBytes(data,width,height,options,from);
  return pixels>0&&dense(bytes,pixels);
}
function textLike(data,width,height){
  const cols=width>>5,rows=height>>5;if(!cols||!rows)return false;
  const cells=photoCells(data,width,height),text=photoCellText(cells,0,0,cols-1,rows-1);
  let n=0;for(let i=0;i<text.length;i++)n+=text[i];
  return n*32>cols*rows;
}
const joined = parts => {
  const size=parts.reduce((n,p)=>n+p.length,0);admitOutputSize(size);
  const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}return bytes;
};
const crop=(data,width,r)=>viewPixels(data,r.width,r.height,width,r.y*width+r.x);
function meet(a,b){
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);return {x,y,width:Math.min(a.x+a.width,b.x+b.width)-x,height:Math.min(a.y+a.height,b.y+b.height)-y};
}

export function validPhotoRegions(data,width,height,regions){
  if(!Array.isArray(regions)||!regions.length)return false;
  for(let i=0;i<regions.length;i++){
    const r=regions[i];
    if(!r||![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>width||r.y+r.height>height)return false;
    for(let j=0;j<i;j++){const b=regions[j];if(r.x<b.x+b.width&&r.x+r.width>b.x&&r.y<b.y+b.height&&r.y+r.height>b.y)return false;}
  }
  return true;
}
const GRAPHIC=64;
const palette=(data,width,r)=>paletteKind(data,width,r.x,r.y,r.width,r.height);
function edgeText(data,width,height,r){
  const step=(a,b)=>Math.max(Math.abs(data[a]-data[b]),Math.abs(data[a+1]-data[b+1]),Math.abs(data[a+2]-data[b+2]));
  const cols=width>>5,rows=height>>5,x1=Math.ceil((r.x+r.width)/32),y1=Math.ceil((r.y+r.height)/32);
  for(let ty=r.y>>5;ty<y1;ty++)for(let tx=r.x>>5;tx<x1;tx++){
    if(tx<cols&&ty<rows)continue;
    const w=Math.min(32,width-tx*32),h=Math.min(32,height-ty*32);
    if(w<8||h<8)return true;
    let steps=0,medium=0,flat=0;const n=(w-1)*(h-1);
    for(let y=0;y<h-1;y++)for(let x=0,at=((ty*32+y)*width+tx*32)*4;x<w-1;x++,at+=4){
      const d=step(at,at+4);if(d>=3&&d<24)medium++;flat+=d<3;steps+=d>=24||step(at,at+width*4)>=24;
    }
    if(steps*961>=64*n&&medium*10<n&&flat*4>=n)return true;
  }
  return false;
}
export function captureGraphicRegions(data,width,height,hints,exactRects=[],textComplete=false){
  if(!(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true))return [];
  const boxes=[];
  let cells=null;
  for(const h of hints){
    const x=Math.max(0,h.x),y=Math.max(0,h.y),r={x,y,width:Math.min(width,h.x+h.width)-x,height:Math.min(height,h.y+h.height)-y};
    const kind=r.width>=GRAPHIC&&r.height>=GRAPHIC?palette(data,width,r):-1;
    if(kind===0&&!exactRects.length&&!textComplete){
      const x0=r.x>>5,y0=r.y>>5,x1=Math.min(width>>5,Math.ceil((r.x+r.width)/32))-1,y1=Math.min(height>>5,Math.ceil((r.y+r.height)/32))-1;
      if(x0<=x1&&y0<=y1){
        cells??=photoCells(data,width,height);
        const text=photoCellText(cells,x0,y0,x1,y1);
        let has=false;
        for(let ty=y0;!has&&ty<=y1;ty++)for(let tx=x0;tx<=x1;tx++)if(text[ty*cells.cols+tx]){has=true;break;}
        if(has)continue;
      }
      if(edgeText(data,width,height,r))continue;
    }
    if(kind===0&&drawnRegion(data,width,r,cells??=photoCells(data,width,height)))continue;
    if(kind>=0)boxes.push({...r,palette:kind===1,parts:[r]});
  }
  for(let a=0;a<boxes.length;a++)for(let b=a+1;b<boxes.length;b++)if(meets(boxes[a],boxes[b])){
    const p=boxes[a],q=boxes[b],x=Math.min(p.x,q.x),y=Math.min(p.y,q.y);
    boxes[a]={x,y,width:Math.max(p.x+p.width,q.x+q.width)-x,height:Math.max(p.y+p.height,q.y+q.height)-y,palette:p.palette&&q.palette,parts:[...p.parts,...q.parts]};boxes.splice(b,1);a=-1;break;
  }
  return boxes;
}
const PRICED = new Uint8Array(0);
function graphicWins(data,width,r,quality,effort,tools){
  if(!(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true))return null;
  const pixels=crop(data,width,r);
  if(r.palette===false){
    const mod=lossyModularLength(pixels,r.width,r.height,quality,false);
    return mod<encodeCaptureBytes(pixels,r.width,r.height,{effort:1,[CAPTURE_TOOLS]:tools}).length?PRICED:null;
  }
  const sections=lossyModularSections(pixels,r.width,r.height,quality,false);
  return sections.reduce((n,s)=>n+s.length,0)<encodeCaptureBytes(pixels,r.width,r.height,{effort:1,[CAPTURE_TOOLS]:tools}).length?sections:null;
}
function coveredArea(rects,width,height){
  const rs=[];
  for(const r of rects){
    const x0=Math.max(0,r.x),y0=Math.max(0,r.y),x1=Math.min(width,r.x+r.width),y1=Math.min(height,r.y+r.height);
    if(x1>x0&&y1>y0)rs.push({x0,y0,x1,y1});
  }
  if(!rs.length||rs.length>64)return 0;
  const ys=[...new Set(rs.flatMap(r=>[r.y0,r.y1]))].sort((a,b)=>a-b);
  let area=0;
  for(let j=0;j+1<ys.length;j++){
    const y=ys[j],dy=ys[j+1]-y,spans=rs.filter(r=>y>=r.y0&&y<r.y1).sort((a,b)=>a.x0-b.x0);
    let end=0;
    for(const s of spans)if(s.x1>end){area+=(s.x1-Math.max(s.x0,end))*dy;end=s.x1;}
  }
  return area;
}
const SPREAD=0.75;
function spread(rects){
  const phases=new Map();let all=0;
  for(const r of rects){const k=(r.y&7)*8+(r.x&7),a=r.width*r.height;phases.set(k,(phases.get(k)??0)+a);all+=a;}
  return all>0&&Math.max(...phases.values())<SPREAD*all;
}
const meets=(p,q)=>p.x<q.x+q.width&&q.x<p.x+p.width&&p.y<q.y+q.height&&q.y<p.y+p.height;
const HINT = 0.25;
const HINTED=0.75;
function trimToPhotograph(data,width,r,exactRects,cells){
  if(!cells||r.width<64||r.height<64)return r;
  const wx0=Math.ceil(r.x/32),wy0=Math.ceil(r.y/32),wx1=Math.floor((r.x+r.width)/32)-1,wy1=Math.floor((r.y+r.height)/32)-1;
  if(wx0>wx1||wy0>wy1)return r;
  const text=photoCellText(cells,wx0,wy0,wx1,wy1);
  let marks=0,px0=wx1+1,px1=wx0-1,py0=wy1+1,py1=wy0-1;
  for(let ty=wy0;ty<=wy1;ty++)for(let tx=wx0;tx<=wx1;tx++){
    const i=ty*cells.cols+tx,k=cells.kind[i];
    if(k>0){if(tx<px0)px0=tx;if(tx>px1)px1=tx;if(ty<py0)py0=ty;if(ty>py1)py1=ty;}
    else if(k===0&&text[i]>0&&!exactRects.some(e=>meets(e,{x:tx*32,y:ty*32,width:32,height:32})))marks++;
  }
  if(marks<HINT*(wx1-wx0+1)*(wy1-wy0+1)||px0>px1)return r;
  const x0=px0>wx0?px0*32:r.x,x1=px1<wx1?(px1+1)*32:r.x+r.width,y0=py0>wy0?py0*32:r.y,y1=py1<wy1?(py1+1)*32:r.y+r.height;
  if(!(x1>x0&&y1>y0))return r;
  const cut=[{x:r.x,y:r.y,width:x0-r.x,height:r.height},{x:x1,y:r.y,width:r.x+r.width-x1,height:r.height},
    {x:x0,y:r.y,width:x1-x0,height:y0-r.y},{x:x0,y:y1,width:x1-x0,height:r.y+r.height-y1}];
  for(const c of cut)if(c.width>=32&&c.height>=32&&flatSamples(data,c.width,c.height,0,width,c.x,c.y)<128)return r;
  return {x:x0,y:y0,width:x1-x0,height:y1-y0};
}
export function capturePhotoRegions(data,width,height,hints=[],exactRects=[],textComplete=false,gradient=false){
  const kept=[],cells=hints.length?photoCells(data,width,height):null,trimmed=hints.slice();
  for(let hi=0;hi<hints.length;hi++){
    let r=meet({x:0,y:0,width,height},hints[hi]);
    if(r.width<1||r.height<1)continue;
    const share=screenPhotoTiles(data,width,height,r,exactRects,cells,textComplete);
    const flat=r.width>=32&&r.height>=32?flatSamples(data,r.width,r.height,0,width,r.x,r.y):256;
    const bars=share>=HINT||share>=0.1&&flat<96;
    if(!(bars||textComplete&&flat<192))continue;
    if((typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&textComplete){const t=trimToPhotograph(data,width,r,exactRects,cells);if(t!==r)r=trimmed[hi]=t;}
    if(drawnRegion(data,width,r,cells))continue;
    if((typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&bars&&textComplete){
      const bare=screenPhotoTiles(data,width,height,r,exactRects,cells,false);
      if(!(bare>=HINT||bare>=0.1&&flat<96))r.rescued=true;
    }
    kept.push(r);
  }
  const seeds=screenPhotoRegions(data,width,height,true,kept,cells,hints,gradient);
  if(!validPhotoRegions(data,width,height,seeds))return [];
  const expanded=expandPhotoRegions(data,width,height,seeds,true);
  if(!validPhotoRegions(data,width,height,expanded))return [];
  const out=[],keptByKey=new Map();
  for(const k of kept)if(!keptByKey.has(`${k.x},${k.y},${k.width},${k.height}`)||k.rescued)keptByKey.set(`${k.x},${k.y},${k.width},${k.height}`,k);
  const clippedHints=[];
  for(let i=0;i<trimmed.length;i++){
    const h=trimmed[i],clip=meet({x:0,y:0,width,height},h);
    if(clip.width>0&&clip.height>0)clippedHints.push({h,clip,i});
  }
  clippedHints.sort((a,b)=>a.clip.x-b.clip.x||a.i-b.i);
  const regionOrder=expanded.map((_,i)=>i).sort((i,j)=>expanded[i].x-expanded[j].x);
  const insideLists=new Array(expanded.length);
  let h0=0;
  for(const rIdx of regionOrder){
    const r=expanded[rIdx],rx1=r.x+r.width,found=[];
    while(h0<clippedHints.length&&clippedHints[h0].clip.x+clippedHints[h0].clip.width<=r.x)h0++;
    for(let hi=h0;hi<clippedHints.length&&clippedHints[hi].clip.x<rx1;hi++){
      const {h,clip,i}=clippedHints[hi],m=meet(r,h);
      if(m.width>0&&m.height>0){
        const prior=keptByKey.get(`${clip.x},${clip.y},${clip.width},${clip.height}`);
        if(m.width*m.height>=0.9*h.width*h.height||prior&&m.width*m.height>=0.5*h.width*h.height&&photoKernels().opaque(data,width,clip.x,clip.y,clip.width,clip.height)){
          const c={...clip};
          if(prior?.rescued)c.rescued=true;
          found.push({c,i});
        }
      }
    }
    found.sort((a,b)=>a.i-b.i);
    insideLists[rIdx]=found.map(f=>f.c);
  }
  for(let rIdx=0;rIdx<expanded.length;rIdx++){
    const r=expanded[rIdx];
    let inside=insideLists[rIdx];
    const rawInside=inside;
    inside=captureMergePhotoHints(inside);
    if(inside.length<rawInside.length){
      if(inside.length===1)inside=[{...inside[0],mergedHints:true}];
      else{
        const sortedRaw=rawInside.slice().sort((a,b)=>a.x-b.x),counts=new Int32Array(inside.length);
        const order=inside.map((_,i)=>i).sort((i,j)=>inside[i].x-inside[j].x);
        let p0=0;
        for(const idx of order){
          const b=inside[idx],bx1=b.x+b.width;
          while(p0<sortedRaw.length&&sortedRaw[p0].x+sortedRaw[p0].width<=b.x)p0++;
          for(let p=p0;p<sortedRaw.length&&sortedRaw[p].x<bx1;p++)if(meets(b,sortedRaw[p])&&++counts[idx]>1)break;
        }
        inside=inside.map((b,i)=>counts[i]>1?{...b,mergedHints:true}:b);
      }
    }
    const ownOnly=inside.length>1&&(inside.reduce((s,h)=>s+h.width*h.height,0)>=HINTED*r.width*r.height||cells&&(()=>{
      const x0=Math.max(0,r.x>>5),y0=Math.max(0,r.y>>5),x1=Math.min(cells.cols,Math.ceil((r.x+r.width)/32)),y1=Math.min(cells.rows,Math.ceil((r.y+r.height)/32));
      for(let ty=y0;ty<y1;ty++)for(let tx=x0;tx<x1;tx++)if(cells.kind[ty*cells.cols+tx]>0&&!inside.some(h=>meets(h,{x:tx*32,y:ty*32,width:32,height:32})))return false;
      return true;
    })());
    if(ownOnly)out.push(...inside);
    else{const box=inside.reduce((b,h)=>{const x=Math.min(b.x,h.x),y=Math.min(b.y,h.y);return {x,y,width:Math.max(b.x+b.width,h.x+h.width)-x,height:Math.max(b.y+b.height,h.y+h.height)-y,rescued:b.rescued||h.rescued,mergedHints:b.mergedHints||h.mergedHints};},r);
      if(!box.rescued)delete box.rescued;if(inside.length>1)box.mergedHints=true;else if(!box.mergedHints)delete box.mergedHints;out.push(box);}
  }
  return validPhotoRegions(data,width,height,out)?out:expanded;
}

function flattenGutterBlocks(rgba,w,h,exact){
  const n=w*h;
  let r=0,g=0,b=0,c=0;
  for(let i=0;i<n;i+=97)if(!exact[i]){r+=rgba[i*4];g+=rgba[i*4+1];b+=rgba[i*4+2];c++;}
  if(c){r=r/c|0;g=g/c|0;b=b/c|0;}else r=g=b=128;
  flattenGutter(rgba,w,h,exact,r,g,b);
}
export const regionFrameBytes=job=>photoFrameBytes(job);
function photoFrameBytes({pixels:given,source,stride,cropRect,width,height,quality,areas,photoCrops,colorSpace,effort=7,placement,graphic,sections,exact,union}){
  const pixels=given??crop(source,stride,cropRect);
  if(exact)fillHoles(pixels,width,height,exact);
  if(union)flattenGutterBlocks(pixels,width,height,exact);
  if(graphic)return lossyModularFrame(pixels,width,height,quality,placement,sections);
  const image=complete(photoCoefficientSteps(pixels,width,height,quality,colorSpace,false,true,areas,{crops:photoCrops}));
  return complete(coefficientAnsSteps(placement===undefined?image:{...image,placement},effort));
}
const UPLOAD = typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true;
function* photoBlockRegionSteps(job, photoBlocks, photoBlockEffort, readingIntent, signal, photoAdmission, readingLook, writerEffort, pageData, regionMemo) {
  if (job.graphic) {
    const bytes = photoFrameBytes(job);
    return photoAdmission ? photoAdmission.record(bytes, false) : bytes;
  }
  if (photoAdmission && photoBlockEffort === 4 && job.photoCropsComplete === false) {
    check(signal);
    const bytes = photoFrameBytes(job);
    check(signal);
    return photoAdmission.record(bytes, false);
  }
  const {pixels:given,source,stride,cropRect,width,height,quality,areas,photoCrops,colorSpace,placement,exact,union} = job;
  const memoKey = pageData && regionMemo && job.photoCropsComplete !== false ? `${placement?.crop?.x},${placement?.crop?.y},${width}x${height}:${placement?.isLastFrame?1:0}:${placement?.mask?1:0}:${quality}:${areas?areas.map(a=>`${a.x},${a.y},${a.width},${a.height},${a.quality}`).join(';'):'-'}:${photoBlockEffort}:${writerEffort}:${readingIntent}:${readingLook}` : null;
  const memoed = memoKey ? regionMemo.get(memoKey) : null, hit = memoed?.data === pageData ? memoed : null;
  if (hit) {
    check(signal);
    return photoAdmission ? photoAdmission.record(hit.bytes, hit.passed, hit.scored) : hit.bytes;
  }
  const pixels = given ?? crop(source, stride, cropRect), reference = pixels.slice();
  if (exact) fillHoles(pixels,width,height,exact);
  if (union) flattenGutterBlocks(pixels,width,height,exact);
  const rows = (top,count) => pixels.subarray(top*width*4,(top+count)*width*4);
  const floorImage = photoAdmission && photoBlockEffort === 4
    ? complete(photoCoefficientSteps(pixels,width,height,quality,colorSpace,false,true,areas,{crops:photoCrops})) : null;
  const bytes = yield* photoBlocks(rows,width,height,{quality,areas,colorSpace,placement,effort:writerEffort??photoBlockEffort??job.effort,
    photoBlockEffort,readingIntent,readingLook,signal,photoCrops,photoAdmission,
    ...(floorImage && {floorImage,floorBytes:writeImage(floorImage,job.effort,placement)}),
    referenceRows:(top,count)=>reference.subarray(top*width*4,(top+count)*width*4),
    exactRows:exact?((top,count)=>exact.subarray(top*width,(top+count)*width)):null,
    project:exact?((rgba,top)=>{for(let i=0;i<rgba.length/4;i++)if(exact[top*width+i])rgba.set(reference.subarray((top*width+i)*4,(top*width+i)*4+4),i*4);}):null});
  if (memoKey && photoAdmission) {
    regionMemo.set(memoKey, {data: pageData, bytes, passed: photoAdmission.accepts(bytes), scored: photoAdmission.scored(bytes)});
  }
  return photoAdmission && job.photoCropsComplete === false ? photoAdmission.record(bytes, false) : bytes;
}
function keepsPieces(kept,pieces,top=0){
  for(const {r,exact,masked} of kept)for(const piece of pieces){
    const x0=Math.max(r.x,piece.x),x1=Math.min(r.x+r.width,piece.x+piece.w);
    const y0=Math.max(r.y+top,piece.y),y1=Math.min(r.y+top+r.height,piece.y+piece.h);
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)
      if((!piece.mask||piece.mask[(y-piece.y)*piece.w+x-piece.x])&&(!masked||!exact[(y-r.y-top)*r.width+x-r.x]))return false;
  }
  return true;
}

export const composeCapturePhoto=(...args)=>complete(composeCapturePhotoSteps(...args));
export function* composeCapturePhotoSteps(data,width,height,quality,colorSpace,regions,{signal,band,effort,baseEffort,baseMemo,regionMemo,tools,trace,asks={},exactRects=[],graphics=[],from=0,regionQuality,photos=[],unhintedBase=false,unionCap=UNION_CAP,photoBlocks=null,photoBlockEffort,readingIntent,readingLook,photoAdmission,reading,textComplete=false,[CAPTURE_PROTECTION]:protection}={}){
  if(regions.length&&!validPhotoRegions(data,width,height,regions)||!validPhotoRegions(data,width,height,[...regions,...graphics]))return null;
  check(signal);
  if(!textComplete){
    const letters=yield* unit('photo-text',()=>findText(data,width,height)?.mask);
    if(letters){
      const whole={x:0,y:0,width,height},kept=captureProtectedBoxes(width,height,[whole],[{exact:letters}],null);
      const boxes=kept.boxes?.map(r=>({x:r.x,y:r.y,width:r.w,height:r.h}))??maskComponents(letters,width,height);
      exactRects=[...exactRects,...boxes.map(r=>({...r,solidText:true}))];
    }
  }
  const found=regions;
  if(regions.length>1&&(!band||band.shape.alpha)){
    const x=Math.min(...regions.map(r=>r.x)),y=Math.min(...regions.map(r=>r.y)),box={x,y,
      width:Math.max(...regions.map(r=>r.x+r.width))-x,height:Math.max(...regions.map(r=>r.y+r.height))-y};
    const minimum=CLUSTER*regions.reduce((n,r)=>n+r.width*r.height,0);
    if(box.width*box.height>=minimum){
      let text=false;
      const cx0=Math.ceil(x/32),cy0=Math.ceil(y/32),cx1=Math.floor((x+box.width)/32)-1,cy1=Math.floor((y+box.height)/32)-1;
      if(cx0<=cx1&&cy0<=cy1){
        const cells=photoCells(data,width,height),stepY=Math.max(1,Math.floor(256/(cx1-cx0+1)));
        for(let by=cy0;!text&&by<=cy1;by+=stepY){
          const by1=Math.min(cy1,by+stepY-1);
          let ask=false;
          for(let ty=by;!ask&&ty<=by1;ty++)for(let tx=cx0;tx<=cx1;tx++)
            if(!regions.some(r=>tx*32<r.x+r.width&&tx*32+32>r.x&&ty*32<r.y+r.height&&ty*32+32>r.y)){ask=true;break;}
          if(!ask)continue;
          const cached=photoCellText(cells,cx0,by,cx1,by1);
          for(let ty=by;!text&&ty<=by1;ty++)for(let tx=cx0;tx<=cx1;tx++)
            if(!regions.some(r=>tx*32<r.x+r.width&&tx*32+32>r.x&&ty*32<r.y+r.height&&ty*32+32>r.y)&&cached[ty*cells.cols+tx]){text=true;break;}
        }
      }
      let possible=!text;
      if(possible){
        const {bound,samples}=captureBoxBound(data,width,box,regions);
        const sum=minimum/CLUSTER;
        if(samples&&sum+(box.width*box.height-sum)*bound/samples*1.25<minimum)possible=false;
      }
      if(possible){const [mask]=photoMasks(data,width,height,[box],exactRects,regions.every(r=>photos.some(p=>meets(p,r)))?256:4096);if(mask&&mask.photo>=minimum)regions=[box];}
    }
  }
  if(band&&!band.shape.alpha&&exactRects.length)regions=regions.filter(r=>!exactRects.some(e=>e.x<r.x+r.width&&e.x+e.width>r.x&&e.y<r.y+r.height&&e.y+e.height>r.y));
  const hidden=r=>hiddenColor(data,width,r.x,r.y,r.width,r.height);
  regions=regions.filter(r=>!hidden(r));graphics=graphics.filter(r=>!hidden(r));
  if(!regions.length&&!graphics.length)return null;
  const masks=regions.length?photoMasks(data,width,height,regions,exactRects,r=>photos.some(p=>meets(p,r))?256:4096):[],kept=[],blend=!band||band.shape.alpha;
  if(!reading)releasePhotoMasks(data);
  for(let i=0;i<regions.length;i++){const m=masks[i],masked=m&&m.photo<regions[i].width*regions[i].height;if(m&&(blend||!masked))kept.push({r:regions[i],...m,masked});}
  if(blend)for(const r of graphics){
    const exact=new Uint8Array(r.width*r.height);let photo=r.width*r.height;
    if(r.parts?.length>1){
      exact.fill(1);
      for(const q of r.parts){const x0=Math.max(q.x,r.x)-r.x,x1=Math.min(q.x+q.width,r.x+r.width)-r.x;if(x1<=x0)continue;
        for(let y=Math.max(q.y,r.y)-r.y;y<Math.min(q.y+q.height,r.y+r.height)-r.y;y++)exact.fill(0,y*r.width+x0,y*r.width+x1);}
      for(let i=0;i<exact.length;i++)photo-=exact[i];
    }
    if(!r.palette){
      const gx0=r.x>>5,gy0=r.y>>5,gx1=Math.min((width>>5)-1,((r.x+r.width-1)>>5)),gy1=Math.min((height>>5)-1,((r.y+r.height-1)>>5));
      const cells=gx0<=gx1&&gy0<=gy1?photoCells(data,width,height):null;
      const cached=cells?photoCellText(cells,gx0,gy0,gx1,gy1):null;
      for(let ty=gy0;ty*32<r.y+r.height;ty++)for(let tx=gx0;tx*32<r.x+r.width;tx++){
        if((tx+1)*32<=width&&(ty+1)*32<=height&&!cached[ty*cells.cols+tx])continue;
        for(let y=Math.max(r.y,ty*32);y<Math.min(r.y+r.height,ty*32+32);y++)for(let x=Math.max(r.x,tx*32);x<Math.min(r.x+r.width,tx*32+32);x++){
          const i=(y-r.y)*r.width+x-r.x;if(!exact[i]){exact[i]=1;photo--;}
        }
      }
    }
    for(let y=0,i=0;y<r.height;y++)for(let x=0,at=((r.y+y)*width+r.x)*4+3;x<r.width;x++,i++,at+=4)if(data[at]!==255&&!exact[i]){exact[i]=1;photo--;}
    for(const e of exactRects){const x0=Math.max(r.x,e.x),y0=Math.max(r.y,e.y),x1=Math.min(r.x+r.width,e.x+e.width),y1=Math.min(r.y+r.height,e.y+e.height);
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y-r.y)*r.width+x-r.x;if(!exact[i]){exact[i]=1;photo--;}}}
    const sections=photo&&graphicWins(data,width,r,quality,effort,tools);
    if(sections)kept.push({r,exact,fill:(o=>data[o]|data[o+1]<<8|data[o+2]<<16|data[o+3]<<24)((r.y*width+r.x)*4),photo,masked:photo<r.width*r.height,graphic:true,sections});
  }
  if(!kept.length)return null;
  const phases=new Map(),SPARSE=2;
  for(const k of kept)if(!k.graphic){const key=(k.r.x&7)*8+(k.r.y&7);if(!phases.has(key))phases.set(key,[]);phases.get(key).push(k);}
  const groups=[];
  for(const members of phases.values()){
    members.sort((p,q)=>p.r.y-q.r.y||p.r.x-q.r.x);
    let group=null,box=null,area=0;
    for(const k of members){
      const r=k.r,next=box&&{x:Math.min(box.x,r.x),y:Math.min(box.y,r.y),right:Math.max(box.right,r.x+r.width),bottom:Math.max(box.bottom,r.y+r.height)};
      const near=box&&r.y-box.bottom<=r.height&&box.x-(r.x+r.width)<=r.width&&r.x-box.right<=r.width;
      if(next&&(near||(next.right-next.x)*(next.bottom-next.y)<=SPARSE*(area+r.width*r.height))){group.push(k);box=next;area+=r.width*r.height;continue;}
      groups.push(group=[k]);box={x:r.x,y:r.y,right:r.x+r.width,bottom:r.y+r.height};area=r.width*r.height;
    }
  }
  if(groups.length>unionCap){
    const area=g=>g.reduce((n,k)=>n+k.r.width*k.r.height,0);
    groups.sort((p,q)=>area(q)-area(p));
    const rest=groups.splice(unionCap-1).flat();
    for(const k of rest)k.offGrid=true;
    groups.push(rest);
  }
  const plans=groups.map(lossy=>({lossy,r:photoGroupBox(lossy.map(k=>k.r))}));
  if(!UPLOAD&&photoAdmission&&blend)completePhotoGroups(plans,photos,width,height,band,hidden,kept.filter(k=>k.graphic));
  const frames=[];
  for(const {lossy,r,expanded} of plans){
    if(lossy.length<2&&!expanded||!blend||hidden(r)){frames.push(...lossy);continue;}
    const {exact,photo}=captureUnionExact(r,lossy);
    frames.push({r,exact,fill:lossy[0].fill,photo,masked:true,union:true,...((lossy[0].offGrid||expanded&&lossy.some(k=>((k.r.x-r.x)&7)||((k.r.y-r.y)&7)))&&{offGrid:true})});
  }
  kept.splice(0,kept.length,...frames,...kept.filter(k=>k.graphic));
  const selectedProtection=protection?.mixed(width,height,kept);
  if(reading){
    reading.exact=keepsPieces(kept,reading.pieces,band?.y??0);
    if(reading.requirePieces&&!reading.exact){check(signal);return null;}
  }
  const masked=kept.some(k=>k.masked),alpha=band?band.shape.alpha:masked||!photoKernels().opaque(data,width,0,0,width,height);
  const level={effort,[CAPTURE_TOOLS]:tools,[CAPTURE_TRACE]:trace,...asks,...captureCompareLevel(effort)};
  const span=(1-from)/2,top=band?.y??0,ends=!band||top+height===band.imageHeight;
  const cropSubjects=r=>{
    const hinted=photos.filter(p=>meets(p,r));
    const covered=f=>hinted.length>1&&hinted.reduce((s,p)=>{const m=meet(f,p);return s+(m.width>0&&m.height>0?m.width*m.height:0);},0)*2>=f.width*f.height;
    const inside=found.filter(f=>!((f.mergedHints&&hinted.length)||covered(f))&&f.x>=r.x&&f.y>=r.y&&f.x+f.width<=r.x+r.width&&f.y+f.height<=r.y+r.height);
    return [...(inside.length?inside:hinted.length?[]:[r]),...hinted].map(f=>{
      const m=meet(f,r);return {source:f,crop:{...m,x:m.x-r.x,y:m.y-r.y}};
    });
  };
  const own=(subjects,offGrid=false,r)=>{
    const photoCrops=subjects.map(s=>s.crop),boxes=new Set();
    for(const s of subjects){
      if(s.crop.width<=0||s.crop.height<=0)continue;
      const x0=s.crop.x&~7,y0=s.crop.y&~7;
      boxes.add(`${x0},${y0},${((s.crop.x+s.crop.width+7)&~7)-x0},${((s.crop.y+s.crop.height+7)&~7)-y0}`);
    }
    const multi=boxes.size>1,byCrop=new Map();
    const frame=multi&&r?[{coder:'ycbcr',frameQuality:quality,dx:(8-(r.x&7))&7,dy:(8-(r.y&7))&7,exactRects}]:[];
    for(const s of subjects){
      if(s.crop.width<=0||s.crop.height<=0)continue;
      const x0=s.crop.x&~7,y0=s.crop.y&~7,w=((s.crop.x+s.crop.width+7)&~7)-x0,h=((s.crop.y+s.crop.height+7)&~7)-y0;
      const cropOff=offGrid||Boolean(s.crop.x&7||s.crop.y&7);
      const k=`${x0},${y0},${w},${h}`,q=regionQuality(data,width,s.source,cropOff,colorSpace,...frame),prev=byCrop.get(k);
      if(!prev||q>prev.quality)byCrop.set(k,{x:x0,y:y0,width:w,height:h,quality:q});
    }
    const areas=[...byCrop.values()];
    if(!areas.length)return {quality,most:quality,photoCrops};
    const least=Math.min(...areas.map(a=>a.quality)),most=Math.max(...areas.map(a=>a.quality));
    return least===most&&!multi?{quality:least,most,photoCrops}:{quality,areas,most,photoCrops};
  };
  const jobs=kept.map(({r,exact,masked,graphic,sections,union,offGrid},i)=>{
    const last=ends&&i+1===kept.length,subjects=cropSubjects(r);
    const modular=graphic&&r.palette;
    const placement={...(modular?{}:{isFirstFrame:false}),isLastFrame:last,saveAsReference:last?0:1,imageWidth:width,imageHeight:band?.imageHeight??height,crop:{...r,y:r.y+top},alphaChannel:alpha,mask:masked};
    const read=regionQuality?graphic?{quality:own(subjects,false,r).most}:own(subjects,!!offGrid,r):{quality};
    return {source:data,stride:width,cropRect:r,width:r.width,height:r.height,quality:read.quality,...(read.areas&&{areas:read.areas}),
      photoCrops:read.photoCrops??subjects.map(s=>s.crop),colorSpace,effort,placement,graphic:!!modular,...(modular&&!masked&&!alpha&&sections&&read.quality===quality&&{sections}),...(masked&&{exact}),...(union&&{union:true})};
  });
  const completeCrops=photoAdmission?jobs.map((j,i)=>j.photoCropsComplete=completePhotoCrops(photos,kept[i].r,width,band?.imageHeight??height,top)):null;
  const subjectLists=photoAdmission?.frame?kept.map(k=>cropSubjects(k.r)):null;
  const handle=(UPLOAD||!photoBlocks)&&asks[CAPTURE_HELPERS]&&jobs.length?yield {regions:jobs,ahead:true}:null;
  const unhinted=!photos.length||(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&unhintedBase;
  const targetBaseEffort=!UPLOAD&&!band&&unhinted&&(baseEffort??effort??3)>=4?Math.min(baseEffort??effort,7):effort;
  const richBase=!UPLOAD&&!band&&unhinted&&(targetBaseEffort??3)>=4;
  const baseKey=richBase?`${width}x${height}:${colorSpace}:${targetBaseEffort}:${alpha}:${kept.map(c=>`${c.r.x},${c.r.y},${c.r.width},${c.r.height},${c.photo},${c.fill}`).join(';')}`:null;
  const memoed=baseKey&&!asks.journal&&baseMemo?.get(baseKey);
  let baseBytes=memoed&&memoed.data===data?memoed.bytes:null;
  if(!baseBytes){
    let base=new (data instanceof Uint8ClampedArray?Uint8ClampedArray:Uint8Array)(data);
    captureFillUnder(new Int32Array(base.buffer),width,kept);
    baseBytes=yield* within(band||(masked&&!richBase)?captureBandSteps(base,width,height,{...(band??{y:0,imageHeight:height}),...level,shape:{colour:3,alpha},colorSpace,[CAPTURE_BASE]:'reference',signal})
      :encodeCaptureSteps(base,width,height,{...level,effort:targetBaseEffort,colorSpace,[CAPTURE_BASE]:'reference',...(richBase&&{[CAPTURE_FLOOR]:{colour:3,alpha},...(targetBaseEffort>=6&&{[CAPTURE_PATCHES]:'peel'})}),signal}),from,span);
    base=null;
    if(baseKey&&!asks.journal&&baseMemo)baseMemo.set(baseKey,{data,bytes:baseBytes});
  }
  const parts=[baseBytes];
  const given=handle?typeof handle.then==='function'?yield {await:handle,regions:true}:handle:null;
  for(let i=0;i<jobs.length;i++){
    check(signal);
    const got=Array.isArray(given)&&given[i] instanceof Uint8Array?given[i]:null;
    parts.push(!UPLOAD&&photoBlocks ? yield* within(photoBlockRegionSteps(jobs[i],photoBlocks,photoBlockEffort,readingIntent,signal,photoAdmission,readingLook,targetBaseEffort,asks.journal?null:data,regionMemo),from+span*(1+i)/(1+kept.length),span/(1+kept.length))
      : got??regionFrameBytes(jobs[i]));jobs[i]=null;
    if(subjectLists){
      const r=kept[i].r,list=subjectLists[i];
      if(!kept[i].graphic&&completeCrops?.[i]!==false&&photoAdmission.crops)
        photoAdmission.crops(list.map(s=>({source:s.source,crops:list.filter(u=>meets(u.crop,s.crop))
          .map(u=>({x:r.x+u.crop.x,y:r.y+top+u.crop.y,width:u.crop.width,height:u.crop.height}))})),parts.at(-1));
      else photoAdmission.frame(list.map(s=>s.source),parts.at(-1));
    }
    yield from+span*(2+i)/(1+kept.length);
  }
  check(signal);const bytes=joined(parts);protection?.record(bytes,selectedProtection);return photoAdmission?photoAdmission.join(bytes,parts):bytes;
}

const photoGroupBox=rects=>{
  const x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y));
  return {x,y,width:Math.max(...rects.map(r=>r.x+r.width))-x,height:Math.max(...rects.map(r=>r.y+r.height))-y};
};
function completePhotoGroups(plans,photos,width,height,band,hidden,graphics){
  const top=band?.y??0,imageHeight=band?.imageHeight??height;
  const crops=photos.map(p=>{
    const x=Math.max(0,p.x),y=Math.max(0,p.y+top),right=Math.min(width,p.x+p.width),bottom=Math.min(imageHeight,p.y+top+p.height);
    return {x,y:y-top,width:right-x,height:bottom-y};
  }).filter(p=>p.width>0&&p.height>0);
  for(let i=0;i<plans.length;i++){
    if(completePhotoCrops(photos,plans[i].r,width,imageHeight,top))continue;
    const selected=new Set([i]),subjects=new Set();let r=plans[i].r,changed=true;
    while(changed){
      changed=false;
      for(const p of crops)if(!subjects.has(p)&&meets(p,r)){subjects.add(p);r=photoGroupBox([r,p]);changed=true;}
      for(let j=0;j<plans.length;j++)if(!selected.has(j)&&[...subjects].some(p=>meets(p,plans[j].r))){
        selected.add(j);r=photoGroupBox([r,plans[j].r]);changed=true;
      }
    }
    if(r.y<0||r.y+r.height>height||hidden(r)||graphics.some(k=>[...subjects].some(p=>meets(p,k.r))))continue;
    const lossy=[...selected].flatMap(j=>plans[j].lossy);
    plans[i]={lossy,r,expanded:true};
    for(let j=plans.length-1;j>=0;j--)if(j!==i&&selected.has(j)){plans.splice(j,1);if(j<i)i--;}
  }
}
function completePhotoCrops(photos,region,width,imageHeight,top=0){
  for(const p of photos){
    const x=Math.max(0,p.x),y=Math.max(0,p.y+top),right=Math.min(width,p.x+p.width),bottom=Math.min(imageHeight,p.y+top+p.height);
    if(right<=x||bottom<=y)continue;
    const crop={x,y:y-top,width:right-x,height:bottom-y};
    if(meets(crop,region)&&(crop.x<region.x||crop.y<region.y||crop.x+crop.width>region.x+region.width||crop.y+crop.height>region.y+region.height))return false;
  }
  return true;
}

function admitted(data,width,height,options,limits){
  check(options.signal);admitPixels(data,width,height,limits);
  if(!(data instanceof Uint8Array||data instanceof Uint8ClampedArray))throw fault('JXL_INPUT','data: Uint8Array/Uint8ClampedArray RGBA8');
  const {colorSpace}=admitOptions({colorSpace:options.colorSpace}),quality=options.quality;
  if(typeof quality!=='number'||!Number.isFinite(quality)||quality<1||quality>100)throw fault('JXL_OPTIONS','quality: 1-100, 100 exact');
  const effort=options.effort??DEFAULT_EFFORT,tools=options[CAPTURE_TOOLS],trace=options[CAPTURE_TRACE],asks={[CAPTURE_HELPERS]:options[CAPTURE_HELPERS],[CAPTURE_GPU]:options[CAPTURE_GPU]};
  return {colorSpace,quality,effort,tools,trace,asks,level:{effort,[CAPTURE_TOOLS]:tools,[CAPTURE_TRACE]:trace,...asks},exactRects:(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)?options.exactRects??[]:[]};
}
function textBoxes(data,under,width,height){
  const n=width*height,{diff,count}=captureTextDiff(data,under,n);
  return count&&count*2<=n?maskComponents(diff,width,height).map(b=>({...b,solidText:true})):[];
}
function layeredMask(data,width,height,exactRects,withoutText){
  const under=withoutText?.data,found=protectedPageBoxes(under??data,width,height);
  if(!found)return null;
  const differ=under?captureTextDiff(data,under,width*height).diff:null,mask=differ??new Uint8Array(width*height),released=withoutText?.rects??[];
  for(const b of found.boxes)for(let y=b.y;y<b.y+b.h;y++)mask.fill(1,y*width+b.x,y*width+b.x+b.w);
  const letters=under?null:findText(data,width,height)?.mask;
  if(letters)for(let i=0;i<letters.length;i++)mask[i]|=letters[i];
  const inside=(r,q)=>r.x>=q.x&&r.y>=q.y&&r.x+r.width<=q.x+q.width&&r.y+r.height<=q.y+q.height;
  for(const r of exactRects)if(!(under&&released.some(q=>inside(r,q))))for(let y=r.y;y<r.y+r.height;y++)mask.fill(1,y*width+r.x,y*width+r.x+r.width);
  return mask;
}
function* photoSteps(data,width,height,options,band,large=false,reading=options.captureReading){
  const {colorSpace,quality,effort,tools,trace,asks,level:admittedLevel,exactRects:rects}=admitted(data,width,height,options,large?BANDED_LIMITS:undefined),{signal,photoAdmission}=options;
  const level=quality<100?{...admittedLevel,...captureCompareLevel(effort)}:admittedLevel;
  const exactFile=(from,answer=false)=>within(band?captureBandSteps(data,width,height,{...band,...level,colorSpace,maxError:0,signal}):encodeCaptureSteps(data,width,height,{...level,...(answer&&{[CAPTURE_LEVEL]:undefined}),small:options.small,[CAPTURE_SMALL_FLOOR]:options[CAPTURE_SMALL_FLOOR],colorSpace,maxError:0,signal}),from,1-from);
  if(quality===100)return yield* exactFile(0);
  const top=band?.y??0,given=rects.filter(e=>e.edge!==true).map(e=>({...e,y:e.y-top})).filter(e=>e.y<height&&e.y+e.height>0);
  const derived=(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&options.withoutText&&!rects.length&&!options.withoutText.rects?(yield* unit('text-boxes',()=>textBoxes(data,options.withoutText.data.subarray(top*width*4,(top+height)*width*4),width,height))):[];
  const exactRects=derived.length?derived:given,withoutText=derived.length?{...options.withoutText,rects:derived}:options.withoutText;
  const layeredInstead=function*(answer){
    if(!(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)||band||colorSpace!=='srgb'||!captureExact(answer)||!exactRects.length&&!withoutText)return answer;
    const mask=layeredMask(data,width,height,exactRects,withoutText);
    if(!mask)return answer;
    const own=(options.wholeQuality??regionRead)?.(data,width,{x:0,y:0,width,height},false,colorSpace)??quality;
    const layered=photoTextLayers(data,width,height,mask,own,effort,tools);
    check(signal);
    return layered&&layered.length<answer.length&&(!photoAdmission||photoAdmission.accepts(layered))?layered:answer;
  };
  const asked=(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)?options.photoRects??[]:[],photos=asked.length>MERGE_HINTS?captureMergePhotoHints(asked):asked,subjects=options.photoSubjects??(photos===asked?asked:photos);
  const photoRects=top?photos.map(e=>({...e,y:e.y-top})):photos,askedRects=photos===asked?photoRects:top?asked.map(e=>({...e,y:e.y-top})):asked;
  const photoSubjects=subjects===photos?photoRects:top?subjects.map(e=>({...e,y:e.y-top})):subjects;
  let regions=options.regions??(yield* unit('photo-regions',()=>capturePhotoRegions(data,width,height,photoRects,exactRects,(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&options.textComplete===true,options[GRADIENT]===true))),exact=null;
  check(signal);
  const readQuality=options.regionQuality,high=options.readingIntent===undefined||options.readingIntent>=0.9;
  let tap=null;
  const regionRead=(pixels,stride,rect,...rest)=>{
    if(!readQuality)return undefined;
    let kind=null;
    const q=readQuality(pixels,stride,rect,...rest,{onProbe(k){kind=k;}});
    if(tap&&rect)tap.push([{x:rect.x,y:rect.y,width:rect.width,height:rect.height},q]);
    if(!(high&&rect?.rescued===true&&typeof q==='number'&&Number.isFinite(q)&&q>=1&&q<99))return q;
    return kind==='full'?q:Math.min(99,q+(kind==='window'?0.3:1));
  };
  const readings={*tapped(steps){const was=tap,taken=tap=[];try{return [yield* steps,taken];}finally{tap=was;}},
    taps(run){const was=tap,taken=tap=[];try{return [run(),taken];}finally{tap=was;}},
    seen(taken){for(const [r,q] of taken)readQuality.seen(r,q);}};
  const small=width*height<SMALL,flat=yield* unit('flat',()=>flatSamples(data,width,height)<=32);
  if(small&&flat)exact=yield* within(exactFile(0),0,0.4);
  const classified=!large&&flat&&!(yield* unit('text-like',()=>textLike(data,width,height)))&&(exact?dense(exact.length,width*height):covers(regions,width,height)||(yield* denseStrips(data,width,height,{...level,colorSpace,maxError:0,signal},0)));
  const unlettered=!classified&&!large&&!band&&!exactRects.length&&smallPicture(width,height)&&
    ((UPLOAD?undefined:options.wholePhotoRoute)?.effort??options.photoBlockEffort??effort??DEFAULT_EFFORT)<MEASURED_EFFORT&&!(yield* unit('letters',()=>lettersFound(data,width,height)));
  if(unlettered)exact??=yield* within(exactFile(0),0,0.4);
  const whole=classified||unlettered;
  if((typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&whole&&exactRects.length&&band&&!band.shape.alpha)return exact??(yield* exactFile(0));
  if(whole&&!exactRects.length&&!((typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&reading?.exactRects?.length)){
    const own=(options.wholeQuality??regionRead)?.(data,width,{x:0,y:0,width,height},false,colorSpace)??quality;
    const partial=photoSubjects.some(r=>r.x>0||r.y>0||r.x+r.width<width||r.y+r.height<height);
    const route=UPLOAD?null:options.wholePhotoRoute,measuredWhole=partial&&route&&route.effort>=MEASURED_EFFORT;
    const measuredCrops=!UPLOAD&&photoAdmission&&options.photoBlocks&&(options.photoBlockEffort??effort??DEFAULT_EFFORT)>=4&&partial&&!measuredWhole;
    if(!band&&!measuredCrops){
      const retainFloor=route?function*(floor){if(!floor&&!exact)exact=yield* exactFile(0);}:null;
      const asked=route?.effort??options.photoBlockEffort??effort??DEFAULT_EFFORT;
      const whole=at=>(options.wholePhoto??lowWholePhotoSteps)(data,width,height,{quality:own,colorSpace,effort:at,
        ...(route&&{firstEffort:4,retainFloor,preview:route.preview}),readingIntent:options.readingIntent,signal,
        photoAdmission,photoSearch:options.photoSearch,...(measuredWhole&&{photoCrops:photoSubjects})});
      let photo;
      if(route&&asked>=8&&smallPicture(width,height)&&!measuredWhole){
        const seven=yield* within(whole(7),exact?0.4:0,exact?0.5:0.5);
        const mine=yield* within(whole(asked),exact?0.5:0.5,exact?0.6:1);
        const ok=file=>file&&(!photoAdmission||photoAdmission.accepts(file));
        photo=ok(seven)&&(!ok(mine)||seven.length<mine.length)?seven:mine;
      }else photo=yield* within(whole(asked),exact?0.4:0,exact?0.6:1);
      check(signal);
      const result=!photo||exact&&(exact.length<=photo.length||photoAdmission&&!photoAdmission.accepts(photo))
        ?exact??(yield* exactFile(0.9)):photo;
      if(reading&&result===photo){reading.wholePhoto=true;reading.exact&&=keepsPieces([{r:{x:0,y:0,width,height},masked:false}],reading.pieces,top);}
      if(result===photo)options[CAPTURE_PROTECTION]?.empty(result,width,height);
      if(route)route.complete=true;
      return result;
    }
    let image;
    image??=complete(photoCoefficientSteps(data,width,height,own,colorSpace,false,true));
    const last=!band||top+height===band.imageHeight,placement=band?{isFirstFrame:!top,isLastFrame:last,saveAsReference:last?0:1,
      imageWidth:width,imageHeight:band.imageHeight,crop:last&&!top?null:{x:0,y:top,width,height},alphaChannel:band.shape.alpha}:{alphaChannel:Boolean(image.alpha)};
    let photo=writeImage(image,effort,placement);
    if(!UPLOAD&&options.photoBlocks){
      const rows=(y,count)=>data.subarray(y*width*4,(y+count)*width*4);
      const frame={quality:own,colorSpace,placement,effort:options.photoBlockEffort??effort,readingIntent:options.readingIntent,readingLook:options.readingLook,signal,photoAdmission,
        photoCrops:photoSubjects.length?[{x:0,y:0,width,height},...photoSubjects]:undefined};
      if(photoAdmission)photo=yield* within(options.photoBlocks(rows,width,height,{...frame,
        photoBlockEffort:4,floorImage:image,floorBytes:photo}),exact?0.4:0,0);
      if(!photoAdmission||options.photoBlockEffort!==4){
        const candidate=yield* within(options.photoBlocks(rows,width,height,{...frame,
          photoBlockEffort:options.photoBlockEffort}),exact?0.4:0,exact?0.6:1);
        if(photoAdmission?photoAdmission.accepts(candidate)&&(!photoAdmission.accepts(photo)||candidate.length<photo.length):candidate.length<photo.length)photo=candidate;
      }
      if(photoAdmission&&!completePhotoCrops(photoSubjects,{x:0,y:0,width,height},width,band?.imageHeight??height,top))photoAdmission.record(photo,false);
    }
    check(signal);const result=exact&&(exact.length<=photo.length||photoAdmission&&!photoAdmission.accepts(photo))?exact:photo;
    if(reading&&result===photo){reading.wholePhoto=true;reading.exact&&=keepsPieces([{r:{x:0,y:0,width,height},masked:false}],reading.pieces,top);}
    if(result===photo)options[CAPTURE_PROTECTION]?.empty(result,width,height);
    return result;
  }
  if(whole)regions=[{x:0,y:0,width,height}];
  let graphics=yield* unit('graphic-regions',()=>captureGraphicRegions(data,width,height,photoRects,exactRects,(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&options.textComplete===true));
  if((typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&effort>=3&&!band&&!large&&colorSpace==='srgb'&&options.textComplete===true&&!photoRects.length&&!regions.length&&options.readingIntent!==undefined){
    const smooth=yield* unit('smooth-regions',()=>captureSmoothRegions(data,width,height,rects));
    if(smooth.length){
      const quantized=yield* unit('smooth-quantize',()=>smoothQuantize(data,width,height,smooth,rects,options.readingIntent,signal));
      if(quantized.kept.length){
        const made=yield* within(encodeCaptureSteps(quantized.pixels,width,height,{...level,colorSpace,maxError:0,signal}),0,1),bytes=made.slice();
        const quick=(yield* within(encodeCaptureSteps(data,width,height,{...level,effort:1,colorSpace,maxError:0,signal}),0,0)).slice();
        if(quick.length<=bytes.length)return effort===1?quick:(yield* exactFile(0));
        const protection=options[CAPTURE_PROTECTION];
        protection?.record(bytes,protection.mixed(width,height,quantized.kept));
        return photoAdmission?photoAdmission.record(bytes,true,quantized.measurements):bytes;
      }
    }
  }
  const gradientInstead=function*(incumbent){
    if(band||large||colorSpace!=='srgb'||exactRects.length||photoRects.length||regions.length||graphics.length||withoutText||options.readingIntent===undefined||options.textComplete===true||reading||options[CAPTURE_PROTECTION])return incumbent;
    const actualEffort=((UPLOAD?undefined:options.wholePhotoRoute)?.effort??options.photoBlockEffort??effort)??3;
    const measured=actualEffort>=MEASURED_EFFORT;
    const layered=yield* unit('gradient-page',()=>gradientPageLayers(data,width,height,options.readingIntent,actualEffort,tools,signal,{measured,libjxl:!UPLOAD,memo:UPLOAD?undefined:options.baseMemo}));
    check(signal);
    if(!layered||!(layered.bytes.length<incumbent.length))return incumbent;
    if(!(actualEffort===1&&captureExact(incumbent))&&layered.bytes.length*4>=incumbent.length*3){
      const quick=markCaptureExact((yield* within(encodeCaptureSteps(data,width,height,{...level,effort:1,colorSpace,maxError:0,signal}),0.9,0)).slice());
      if(quick.length<=layered.bytes.length)return actualEffort===1?quick:captureExact(incumbent)?incumbent:(yield* exactFile(0.9));
    }
    return photoAdmission?photoAdmission.record(layered.bytes.slice(),true,[{metric:'ssimulacra2',score:layered.score,floor:layered.floor,domain:'encoder-reconstruction'}]):layered.bytes.slice();
  };
  if(effort>=3&&!band&&!large&&colorSpace==='srgb'&&!exactRects.length&&!photoRects.length&&!regions.length&&!graphics.length&&!withoutText&&options.readingIntent!==undefined&&options.textComplete!==true){
    const measured=((UPLOAD?undefined:options.wholePhotoRoute)?.effort??options.photoBlockEffort??effort)>=MEASURED_EFFORT;
    const memo=measured||width*height<=2.5e6?PAGE_PALETTES.get(data)??new Map():null,key=`${options.readingIntent}|${measured}|${effort}`;
    if(memo){
      PAGE_PALETTES.set(data,memo);
      let made=memo.get(key);
      if(made===undefined){
        const paletted=yield* unit('page-palette',()=>pagePalette(data,width,height,options.readingIntent,signal,measured,!UPLOAD));
        made=null;
        if(paletted){
          const bytes=(yield* within(encodeCaptureSteps(paletted.pixels,width,height,{...level,colorSpace,maxError:0,signal}),0,0.9)).slice();
          if(effort<=3){
            const exactBytes=(yield* exactFile(0.9)).slice();
            made=exactBytes.length<=bytes.length?{exact:exactBytes}:{bytes,score:paletted.score,floor:paletted.floor};
          }else{
            const quick=(yield* within(encodeCaptureSteps(data,width,height,{...level,effort:3,colorSpace,maxError:0,signal}),0.9,0)).slice();
            made=quick.length<=bytes.length?false:{bytes,score:paletted.score,floor:paletted.floor};
          }
        }
        memo.set(key,made);
      }
      if(made===false)return yield* gradientInstead(yield* exactFile(0.9));
      if(made?.exact)return yield* gradientInstead(markCaptureExact(made.exact.slice()));
      if(made){
        const palBytes=photoAdmission?photoAdmission.record(made.bytes.slice(),true,[{metric:'ssimulacra2',score:made.score,floor:made.floor,domain:'encoder-reconstruction'}]):made.bytes.slice();
        return yield* gradientInstead(palBytes);
      }
    }
  }
  if(graphics.length){
    const covered=r=>graphics.reduce((s,g)=>{if(!g.palette)return s;const m=meet(r,g);return s+(m.width>0&&m.height>0?m.width*m.height:0);},0)>=HINTED*r.width*r.height;
    regions=regions.filter(r=>!covered(r));graphics=graphics.filter(g=>!regions.some(r=>meets(g,r)));
  }
  if((typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&!band&&exactRects.length&&(regions.length||graphics.length)&&(yield* unit('opaque',()=>photoKernels().opaque(data,width,0,0,width,height)))){
    const read=(r,offGrid)=>regionRead(data,width,r,offGrid,colorSpace)??quality;
    const look=options.look&&(effort??3)>=4&&options.readingIntent!==undefined?options.look:null;
    const readRgb=(r,offGrid,dx=0,dy=0)=>regionRead(data,width,r,offGrid,colorSpace,{coder:'rgb',frameQuality:quality,dx,dy,exactRects})??quality;
    const smallRect=r=>r.width<64||r.height<64;
    const qualityOf=Object.assign(look?Object.assign((r,offGrid,dx,dy)=>smallRect(r)?readRgb(r,offGrid,dx,dy):look(data,width,r,read(r,offGrid),options.readingIntent,dx,dy,exactRects,colorSpace,quality,photoRects),
      {steps:look.steps&&function*(r,offGrid,dx,dy){return smallRect(r)?readRgb(r,offGrid,dx,dy):yield* look.steps(data,width,r,read(r,offGrid),options.readingIntent,dx,dy,exactRects,colorSpace,quality,photoRects);}}):(r,offGrid,dx,dy)=>readRgb(r,offGrid,dx,dy),
      readQuality?.seen?{readings}:{});
    const lossy=[...regions,...graphics];
    const covered=options.textComplete===true&&2*coveredArea(askedRects,width,height)>width*height;
    const at=(UPLOAD?undefined:options.wholePhotoRoute)?.effort??effort??3,noHintFirst=covered&&at>=3&&at<MEASURED_EFFORT&&spread(regions);
    const pageMargin=covered&&at>=MEASURED_EFFORT;
    const baseline=large?null:function*(pieces,unhintedRegions){
      const released=pieces.filter(p=>p.released);
      let bareRects=[];
      if(released.length){
        const diff=new Uint8Array(width*height);
        for(const p of released)for(let y=0;y<p.h;y++)for(let x=0;x<p.w;x++)if(p.mask[y*p.w+x])diff[(p.y+y)*width+p.x+x]=1;
        const boxes=captureProtectedBoxes(width,height,[{x:0,y:0,width,height}],[{exact:diff}],null).boxes;
        bareRects=(boxes?.map(r=>({x:r.x,y:r.y,width:r.w,height:r.h}))??maskComponents(diff,width,height)).map(r=>({...r,solidText:true}));
      }
      const reading={pieces,exactRects:bareRects,exact:true,requirePieces:true,textComplete:options.textComplete===true||Boolean(withoutText)};
      const hinted=options.textComplete===true&&photoRects.length>0;
      const reads=[],read=readQuality&&((...a)=>{const q=pageMargin?readQuality(a[0],a[1],a[2],a[3],a[4],...a.slice(5),PAGE_MARGIN):readQuality(...a);const r=a[2];if(r)reads.push([{x:r.x,y:r.y,width:r.width,height:r.height},q]);return q;});
      const bytes=yield* photoSteps(data,width,height,{...options,...(read&&{regionQuality:read}),wholePhotoRoute:null,...(!UPLOAD&&{baseEffort:at}),exactRects:[],photoRects:[],withoutText:undefined,textComplete:undefined,photoSubjects:photoAdmission||hinted&&photoSubjects.length<=256?photoSubjects:[],regions:hinted&&regions.length?regions:unhintedRegions},undefined,false,reading);
      return {bytes,exact:reading.exact,wholePhoto:reading.wholePhoto===true,reads};
    };
    if(baseline)baseline.seen=reads=>{for(const [r,q] of reads)readQuality?.seen?.(r,q);};
    const page=yield* within(patchedPageSteps(data,width,height,{quality,regions:lossy,unconfirmed:graphics.length>0,confirmedPhotos:regions.length>0,textComplete:options.textComplete===true,qualityOf,exactRects,colorSpace,exactOptions:{...level,signal},
      photoBlocks:options.photoBlocks,photoBlockEffort:options.photoBlockEffort,readingIntent:options.readingIntent,readingLook:options.readingLook,photoRects:photoSubjects,photoAdmission,photoScoreMemo:options.photoScoreMemo,baseline,noHintFirst,pageRoute:options.pageRoute,textReading:options.textReading,withoutText,[CAPTURE_PROTECTION]:options[CAPTURE_PROTECTION],[CAPTURE_FACTS]:options[CAPTURE_FACTS]}),exact?0.4:0,exact?0.6:1);
    if(page){
      check(signal);
      const answer=exact&&(exact.length<=page.length||photoAdmission&&!photoAdmission.accepts(page))?exact:page;
      return yield* layeredInstead(answer);
    }
  }
  if(large)return null;
  const sparse=[...regions,...graphics].reduce((s,r)=>s+r.width*r.height,0)*8<width*height;
  const mixedReading=reading&&{pieces:reading.pieces,exact:true,requirePieces:reading.requirePieces&&!exact&&!sparse};
  const at=exact?0.4:0,mixed=regions.length||graphics.length?yield* composeCapturePhotoSteps(data,width,height,quality,colorSpace,regions,{signal,band,effort,baseEffort:((typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&!UPLOAD?options.baseEffort:undefined)??(UPLOAD?undefined:options.wholePhotoRoute)?.effort??effort,baseMemo:UPLOAD?undefined:options.baseMemo,regionMemo:UPLOAD?undefined:options.regionMemo,tools,trace,asks,exactRects:(typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&reading?.exactRects?.length?reading.exactRects:exactRects,graphics,from:at,regionQuality:readQuality?regionRead:undefined,photos:photoSubjects,...((typeof __RAPIER_JXL_PAGE_RECTS__==='undefined'||__RAPIER_JXL_PAGE_RECTS__===true)&&!UPLOAD&&!photoRects.length&&photoSubjects.length&&{unhintedBase:true}),reading:mixedReading,
    photoBlocks:options.photoBlocks,photoBlockEffort:options.photoBlockEffort,readingIntent:options.readingIntent,readingLook:options.readingLook,photoAdmission,textComplete:options.textComplete===true||Boolean(withoutText)||reading?.textComplete===true,[CAPTURE_PROTECTION]:options[CAPTURE_PROTECTION],...(options.unionCap&&{unionCap:options.unionCap})}):null;
  if(mixedReading?.requirePieces&&mixedReading.exact===false){reading.exact=false;return null;}
  if(mixed&&!exact&&sparse){
    const {bytes,pixels}=yield* stripBytes(data,width,height,{...level,colorSpace,maxError:0,signal},1);
    if(!pixels||mixed.length*pixels>=bytes*width*height)exact=yield* exactFile(1);
  }
  const result=!mixed||exact&&(exact.length<=mixed.length||photoAdmission&&!photoAdmission.accepts(mixed))?yield* layeredInstead(exact??(yield* exactFile(at,!regions.length&&!graphics.length))):mixed;
  releasePhotoMasks(data);
  if(reading&&result===mixed)reading.exact&&=mixedReading.exact;
  return yield* gradientInstead(result);
}
export const encodeCapturePhotoSteps=(data,width,height,options={})=>photoSteps(data,width,height,options);
export const encodeCapturePhotoBytes=(data,width,height,options={})=>complete(photoSteps(data,width,height,options));
export const capturePatchedLargeSteps=(data,width,height,options={})=>photoSteps(data,width,height,options,undefined,true);
export const capturePhotoBandSteps=(data,width,height,options)=>photoSteps(data,width,height,options,
  {y:options.y,imageHeight:options.imageHeight,shape:options.quality===100?options.shape:{...options.shape,colour:3}});
export const capturePhotoBand=(data,width,height,options)=>complete(capturePhotoBandSteps(data,width,height,options));

