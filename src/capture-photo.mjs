// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {admitOptions, admitPixels, admitOutputSize, fault} from './admit.mjs';
import {encodeCaptureSteps, encodeCaptureBytes, captureBandSteps, CAPTURE_BASE, CAPTURE_TOOLS, CAPTURE_TRACE, CAPTURE_HELPERS, CAPTURE_GPU, DEFAULT_EFFORT} from './capture-codec.mjs';
import {photoKernels} from './capture-kernels.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {writeImage} from './photo-image-write.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {lowWholePhotoSteps} from './photo-low.mjs';
import {flatSamples} from './screen-samples.mjs';
import {viewPixels} from './screen-crop.mjs';
import {screenPhotoRegions, screenPhotoTiles, textTiles, photoCells} from './screen-photo-regions.mjs';
import {expandPhotoRegions} from './screen-photo-borders.mjs';
import {photoMasks, fillHoles} from './screen-photo-mask.mjs';
import {lossyModularFrame, lossyModularSections} from './capture-modular-lossy.mjs';
import {patchedPageSteps} from './capture-patched.mjs';
import {CAPTURE_PROTECTION} from './capture-protection.mjs';
import {BANDED_LIMITS} from './memory-device.mjs';
import {unit} from './step-journal.mjs';

const CLUSTER = 1.2;
export const UNION_CAP = Infinity;
const WHOLE = 0.85, SMALL = 2000000;
const check = signal => { if (signal?.aborted) throw signal.reason; };
function* within(steps,from,span){
  let step,reply;
  try{
    while(!(step=steps.next(reply)).done)reply=yield typeof step.value==='number'?from+span*step.value:step.value;
    return step.value;
  }finally{steps.return?.();}
}
function drain(steps){
  try{let step;while(!(step=steps.next()).done);return step.value;}finally{steps.return();}
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
  return textTiles(data,width,0,0,cols-1,rows-1)*32>cols*rows;
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
const GRAPHIC=64,PALETTE=256;
function palette(data,width,r){
  const seen=new Set();let grey=0;
  for(let y=r.y;y<r.y+r.height;y++)for(let i=(y*width+r.x)*4,end=i+r.width*4;i<end;i+=4){
    const c=data[i]<<16|data[i+1]<<8|data[i+2];
    if(!seen.has(c)){seen.add(c);if(seen.size>PALETTE)return 0;if(data[i]===data[i+1]&&data[i+1]===data[i+2])grey++;}
  }
  return 2*grey<seen.size?1:-1;
}
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
export function captureGraphicRegions(data,width,height,hints,exactRects=[]){
  const boxes=[];
  for(const h of hints){
    const x=Math.max(0,h.x),y=Math.max(0,h.y),r={x,y,width:Math.min(width,h.x+h.width)-x,height:Math.min(height,h.y+h.height)-y};
    const kind=r.width>=GRAPHIC&&r.height>=GRAPHIC?palette(data,width,r):-1;
    if(kind===0&&!exactRects.length&&(textTiles(data,width,r.x>>5,r.y>>5,Math.min(width>>5,Math.ceil((r.x+r.width)/32))-1,Math.min(height>>5,Math.ceil((r.y+r.height)/32))-1)
      ||edgeText(data,width,height,r)))continue;
    if(kind>=0)boxes.push({...r,palette:kind===1,parts:[r]});
  }
  for(let a=0;a<boxes.length;a++)for(let b=a+1;b<boxes.length;b++)if(meets(boxes[a],boxes[b])){
    const p=boxes[a],q=boxes[b],x=Math.min(p.x,q.x),y=Math.min(p.y,q.y);
    boxes[a]={x,y,width:Math.max(p.x+p.width,q.x+q.width)-x,height:Math.max(p.y+p.height,q.y+q.height)-y,palette:p.palette&&q.palette,parts:[...p.parts,...q.parts]};boxes.splice(b,1);a=-1;break;
  }
  return boxes;
}
function graphicWins(data,width,r,quality,effort,tools){
  const pixels=crop(data,width,r),sections=lossyModularSections(pixels,r.width,r.height,quality,false);
  return sections.reduce((n,s)=>n+s.length,0)<encodeCaptureBytes(pixels,r.width,r.height,{effort:1,[CAPTURE_TOOLS]:tools}).length?sections:null;
}
const meets=(p,q)=>p.x<q.x+q.width&&q.x<p.x+p.width&&p.y<q.y+q.height&&q.y<p.y+p.height;
const HINT = 0.25;
const HINTED=0.75;
export function capturePhotoRegions(data,width,height,hints=[],exactRects=[]){
  const kept=[],cells=hints.length?photoCells(data,width,height):null;
  for(const h of hints){
    const r=meet({x:0,y:0,width,height},h);
    const share=screenPhotoTiles(data,width,height,r,exactRects,cells);
    if(share>=HINT||share>=0.1&&flatSamples(data,r.width,r.height,0,width,r.x,r.y)<96)kept.push(r);
  }
  const seeds=screenPhotoRegions(data,width,height,true,kept,cells);
  if(!validPhotoRegions(data,width,height,seeds))return [];
  const expanded=expandPhotoRegions(data,width,height,seeds,true);
  if(!validPhotoRegions(data,width,height,expanded))return [];
  const out=[];
  for(const r of expanded){
    const inside=[];
    for(const h of hints){
      const m=meet(r,h);
      if(m.width>0&&m.height>0&&m.width*m.height>=0.9*h.width*h.height)inside.push(meet({x:0,y:0,width,height},h));
    }
    for(let a=0;a<inside.length;a++)for(let b=a+1;b<inside.length;b++){
      const p=inside[a],q=inside[b];
      if(p.x<q.x+q.width&&q.x<p.x+p.width&&p.y<q.y+q.height&&q.y<p.y+p.height){
        const x=Math.min(p.x,q.x),y=Math.min(p.y,q.y);
        inside[a]={x,y,width:Math.max(p.x+p.width,q.x+q.width)-x,height:Math.max(p.y+p.height,q.y+q.height)-y};inside.splice(b,1);a=-1;break;
      }
    }
    if(inside.length>1&&inside.reduce((s,h)=>s+h.width*h.height,0)>=HINTED*r.width*r.height)out.push(...inside);else out.push(r);
  }
  return validPhotoRegions(data,width,height,out)?out:expanded;
}

function flattenFar(rgba,w,h,exact,far){
  const n=w*h,d=new Uint16Array(n).fill(far+1);
  for(let i=0;i<n;i++)if(!exact[i])d[i]=0;
  for(let y=0,i=0;y<h;y++)for(let x=0;x<w;x++,i++)if(d[i])d[i]=Math.min(d[i],x?d[i-1]+1:far+1,y?d[i-w]+1:far+1);
  for(let y=h-1,i=n-1;y>=0;y--)for(let x=w-1;x>=0;x--,i--)if(d[i])d[i]=Math.min(d[i],x+1<w?d[i+1]+1:far+1,y+1<h?d[i+w]+1:far+1);
  let r=0,g=0,b=0,c=0;
  for(let i=0;i<n;i+=97)if(!exact[i]){r+=rgba[i*4];g+=rgba[i*4+1];b+=rgba[i*4+2];c++;}
  if(c){r=r/c|0;g=g/c|0;b=b/c|0;}else r=g=b=128;
  const bw=Math.ceil(w/8),touched=new Uint8Array(bw*Math.ceil(h/8));
  for(let y=0,i=0;y<h;y++)for(let x=0;x<w;x++,i++)if(!exact[i])touched[(y>>3)*bw+(x>>3)]=1;
  for(let y=0,i=0;y<h;y++)for(let x=0;x<w;x++,i++)if(d[i]>far&&!touched[(y>>3)*bw+(x>>3)]){rgba[i*4]=r;rgba[i*4+1]=g;rgba[i*4+2]=b;}
}
export const regionFrameBytes=job=>photoFrameBytes(job);
function photoFrameBytes({pixels,width,height,quality,areas,colorSpace,effort=7,placement,graphic,sections,exact,far}){
  if(exact)fillHoles(pixels,width,height,exact);
  if(far)flattenFar(pixels,width,height,exact,far);
  if(graphic)return lossyModularFrame(pixels,width,height,quality,placement,sections);
  const image=complete(photoCoefficientSteps(pixels,width,height,quality,colorSpace,false,true,areas));
  return complete(coefficientAnsSteps(placement===undefined?image:{...image,placement},effort));
}
function* photoBlockRegionSteps(job, photoBlocks, photoBlockEffort, readingWebp, signal, photoAdmission) {
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
  const {pixels,width,height,quality,areas,photoCrops,colorSpace,placement,exact,far} = job;
  const reference = pixels.slice();
  if (exact) fillHoles(pixels,width,height,exact);
  if (far) flattenFar(pixels,width,height,exact,far);
  const rows = (top,count) => pixels.subarray(top*width*4,(top+count)*width*4);
  const floorImage = photoAdmission && photoBlockEffort === 4
    ? complete(photoCoefficientSteps(pixels,width,height,quality,colorSpace,false,true,areas)) : null;
  const bytes = yield* photoBlocks(rows,width,height,{quality,areas,colorSpace,placement,effort:photoBlockEffort??job.effort,
    photoBlockEffort,readingWebp,signal,photoCrops,photoAdmission,
    ...(floorImage && {floorImage,floorBytes:writeImage(floorImage,job.effort,placement)}),
    referenceRows:(top,count)=>reference.subarray(top*width*4,(top+count)*width*4),
    exactRows:exact?((top,count)=>exact.subarray(top*width,(top+count)*width)):null,
    project:exact?((rgba,top)=>{for(let i=0;i<rgba.length/4;i++)if(exact[top*width+i])rgba.set(reference.subarray((top*width+i)*4,(top*width+i)*4+4),i*4);}):null});
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

export const composeCapturePhoto=(...args)=>drain(composeCapturePhotoSteps(...args));
export function* composeCapturePhotoSteps(data,width,height,quality,colorSpace,regions,{signal,band,effort,tools,trace,asks={},exactRects=[],graphics=[],from=0,regionQuality,photos=[],unionCap=UNION_CAP,photoBlocks=null,photoBlockEffort,readingWebp,photoAdmission,reading,[CAPTURE_PROTECTION]:protection}={}){
  if(regions.length&&!validPhotoRegions(data,width,height,regions)||!validPhotoRegions(data,width,height,[...regions,...graphics]))return null;
  check(signal);
  const found=regions;
  if(regions.length>1&&(!band||band.shape.alpha)){
    const x=Math.min(...regions.map(r=>r.x)),y=Math.min(...regions.map(r=>r.y)),box={x,y,
      width:Math.max(...regions.map(r=>r.x+r.width))-x,height:Math.max(...regions.map(r=>r.y+r.height))-y};
    const minimum=CLUSTER*regions.reduce((n,r)=>n+r.width*r.height,0);
    if(box.width*box.height>=minimum){
      let text=false;
      for(let ty=Math.ceil(y/32);!text&&(ty+1)*32<=y+box.height;ty++)for(let tx=Math.ceil(x/32);!text&&(tx+1)*32<=x+box.width;tx++)
        if(!regions.some(r=>tx*32<r.x+r.width&&tx*32+32>r.x&&ty*32<r.y+r.height&&ty*32+32>r.y))text=textTiles(data,width,tx,ty,tx,ty)>0;
      let possible=!text;
      if(possible){
        let bound=0,samples=0;
        for(let sy=y;sy<y+box.height-1;sy+=4)for(let sx=x;sx<x+box.width-1;sx+=4){
          if(regions.some(r=>sx>=r.x&&sx<r.x+r.width&&sy>=r.y&&sy<r.y+r.height))continue;
          samples++;const at=(sy*width+sx)*4,right=at+4,down=at+width*4;
          if(!(data[at]===data[right]&&data[at+1]===data[right+1]&&data[at+2]===data[right+2])&&!(data[at]===data[down]&&data[at+1]===data[down+1]&&data[at+2]===data[down+2]))bound++;
        }
        const sum=minimum/CLUSTER;
        if(samples&&sum+(box.width*box.height-sum)*bound/samples*1.25<minimum)possible=false;
      }
      if(possible){const [mask]=photoMasks(data,width,height,[box],exactRects);if(mask&&mask.photo>=minimum)regions=[box];}
    }
  }
  if(band&&!band.shape.alpha&&exactRects.length)regions=regions.filter(r=>!exactRects.some(e=>e.x<r.x+r.width&&e.x+e.width>r.x&&e.y<r.y+r.height&&e.y+e.height>r.y));
  const hidden=r=>{for(let y=r.y;y<r.y+r.height;y++)for(let i=(y*width+r.x)*4,end=i+r.width*4;i<end;i+=4)if(!data[i+3]&&(data[i]|data[i+1]|data[i+2]))return true;return false;};
  regions=regions.filter(r=>!hidden(r));graphics=graphics.filter(r=>!hidden(r));
  if(!regions.length&&!graphics.length)return null;
  const masks=regions.length?photoMasks(data,width,height,regions,exactRects):[],kept=[],blend=!band||band.shape.alpha;
  for(let i=0;i<regions.length;i++){const m=masks[i],masked=m&&m.photo<regions[i].width*regions[i].height;if(m&&(blend||!masked))kept.push({r:regions[i],...m,masked});}
  if(blend)for(const r of graphics){
    const exact=new Uint8Array(r.width*r.height);let photo=r.width*r.height;
    if(r.parts?.length>1)for(let y=0,i=0;y<r.height;y++)for(let x=0;x<r.width;x++,i++){
      const px=r.x+x,py=r.y+y;
      if(!exact[i]&&!r.parts.some(q=>px>=q.x&&px<q.x+q.width&&py>=q.y&&py<q.y+q.height)){exact[i]=1;photo--;}
    }
    if(!r.palette)for(let ty=r.y>>5;ty*32<r.y+r.height;ty++)for(let tx=r.x>>5;tx*32<r.x+r.width;tx++){
      if((tx+1)*32<=width&&(ty+1)*32<=height&&!textTiles(data,width,tx,ty,tx,ty))continue;
      for(let y=Math.max(r.y,ty*32);y<Math.min(r.y+r.height,ty*32+32);y++)for(let x=Math.max(r.x,tx*32);x<Math.min(r.x+r.width,tx*32+32);x++){
        const i=(y-r.y)*r.width+x-r.x;if(!exact[i]){exact[i]=1;photo--;}
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
  const frames=[];
  for(const lossy of groups){
    const x=Math.min(...lossy.map(k=>k.r.x)),y=Math.min(...lossy.map(k=>k.r.y)),r={x,y,width:Math.max(...lossy.map(k=>k.r.x+k.r.width))-x,height:Math.max(...lossy.map(k=>k.r.y+k.r.height))-y};
    if(lossy.length<2||!blend||hidden(r)){frames.push(...lossy);continue;}
    const exact=new Uint8Array(r.width*r.height).fill(1);let photo=0;
    for(const k of lossy)for(let yy=0;yy<k.r.height;yy++)for(let xx=0,at=(k.r.y-y+yy)*r.width+k.r.x-x;xx<k.r.width;xx++)if(!(k.masked&&k.exact[yy*k.r.width+xx])&&exact[at+xx]){exact[at+xx]=0;photo++;}
    frames.push({r,exact,fill:lossy[0].fill,photo,masked:true,union:true,...(lossy[0].offGrid&&{offGrid:true})});
  }
  kept.splice(0,kept.length,...frames,...kept.filter(k=>k.graphic));
  const selectedProtection=protection?.mixed(width,height,kept);
  if(reading){
    reading.exact=keepsPieces(kept,reading.pieces,band?.y??0);
    if(reading.requirePieces&&!reading.exact){check(signal);return null;}
  }
  const base=new (data instanceof Uint8ClampedArray?Uint8ClampedArray:Uint8Array)(data),words=new Int32Array(base.buffer);
  for(const {r,exact,fill,masked} of kept)for(let y=0,i=0,f=fill|0;y<r.height;y++,i+=r.width){
    const at=(r.y+y)*width+r.x;
    if(!masked){words.fill(f,at,at+r.width);continue;}
    for(let x=0;x<r.width;){
      if(exact[i+x]){x++;continue;}
      let end=x+1;while(end<r.width&&!exact[i+end])end++;
      words.fill(f,at+x,at+end);x=end;
    }
  }
  const masked=kept.some(k=>k.masked),alpha=band?band.shape.alpha:masked||!photoKernels().opaque(data,width,0,0,width,height);
  const level={effort,[CAPTURE_TOOLS]:tools,[CAPTURE_TRACE]:trace,...asks};
  const span=(1-from)/2,top=band?.y??0,ends=!band||top+height===band.imageHeight;
  const cropSubjects=r=>{
    const inside=found.filter(f=>f.x>=r.x&&f.y>=r.y&&f.x+f.width<=r.x+r.width&&f.y+f.height<=r.y+r.height);
    return [...(inside.length?inside:[r]),...photos.filter(p=>meets(p,r))].map(f=>{
      const x=Math.max(f.x,r.x),y=Math.max(f.y,r.y);
      return {source:f,crop:{x:x-r.x,y:y-r.y,width:Math.min(f.x+f.width,r.x+r.width)-x,height:Math.min(f.y+f.height,r.y+r.height)-y}};
    });
  };
  const own=(r,offGrid=false)=>{
    const subjects=cropSubjects(r),photoCrops=subjects.map(s=>s.crop);
    const areas=subjects.map(s=>({...s.crop,quality:regionQuality(data,width,s.source,offGrid,colorSpace)}));
    const least=Math.min(...areas.map(a=>a.quality)),most=Math.max(...areas.map(a=>a.quality));
    return least===most?{quality:least,most,photoCrops}:{quality:least,areas,most,photoCrops};
  };
  const jobs=kept.map(({r,exact,masked,graphic,sections,union,offGrid},i)=>{
    const pixels=crop(data,width,r),last=ends&&i+1===kept.length;
    const modular=graphic&&r.palette;
    const placement={...(modular?{}:{isFirstFrame:false}),isLastFrame:last,saveAsReference:last?0:1,imageWidth:width,imageHeight:band?.imageHeight??height,crop:{...r,y:r.y+top},alphaChannel:alpha,mask:masked};
    const read=regionQuality?graphic?{quality:own(r).most}:own(r,!!offGrid):{quality};
    return {pixels,width:r.width,height:r.height,quality:read.quality,...(read.areas&&{areas:read.areas}),
      photoCrops:read.photoCrops??cropSubjects(r).map(s=>s.crop),colorSpace,effort,placement,graphic:!!modular,...(modular&&!masked&&!alpha&&sections&&read.quality===quality&&{sections}),...(masked&&{exact}),...(union&&{far:1})};
  });
  if(photoAdmission)for(let i=0;i<jobs.length;i++)jobs[i].photoCropsComplete=completePhotoCrops(photos,kept[i].r,width,band?.imageHeight??height,top);
  const handle=!photoBlocks&&asks[CAPTURE_HELPERS]&&jobs.length?yield {regions:jobs,ahead:true}:null;
  const parts=[yield* within(band||masked?captureBandSteps(base,width,height,{...(band??{y:0,imageHeight:height}),...level,shape:{colour:3,alpha},colorSpace,[CAPTURE_BASE]:'reference',signal})
    :encodeCaptureSteps(base,width,height,{...level,colorSpace,[CAPTURE_BASE]:'reference',signal}),from,span)];
  const given=handle?typeof handle.then==='function'?yield {await:handle,regions:true}:handle:null;
  for(let i=0;i<jobs.length;i++){
    check(signal);
    const got=Array.isArray(given)&&given[i] instanceof Uint8Array?given[i]:null;
    parts.push(photoBlocks ? yield* within(photoBlockRegionSteps(jobs[i],photoBlocks,photoBlockEffort,readingWebp,signal,photoAdmission),from+span*(1+i)/(1+kept.length),span/(1+kept.length))
      : got??regionFrameBytes(jobs[i]));jobs[i]=null;
    yield from+span*(2+i)/(1+kept.length);
  }
  check(signal);const bytes=joined(parts);protection?.record(bytes,selectedProtection);return photoAdmission?photoAdmission.join(bytes,parts):bytes;
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
  if(!(data instanceof Uint8Array||data instanceof Uint8ClampedArray))throw fault('JXL_INPUT','Captures use straight RGBA8 samples.');
  const {colorSpace}=admitOptions({colorSpace:options.colorSpace}),quality=options.quality;
  if(typeof quality!=='number'||!Number.isFinite(quality)||quality<1||quality>100)throw fault('JXL_OPTIONS','quality is a number from 1 through 100; 100 is exact.');
  const effort=options.effort??DEFAULT_EFFORT,tools=options[CAPTURE_TOOLS],trace=options[CAPTURE_TRACE],asks={[CAPTURE_HELPERS]:options[CAPTURE_HELPERS],[CAPTURE_GPU]:options[CAPTURE_GPU]};
  return {colorSpace,quality,effort,tools,trace,asks,level:{effort,[CAPTURE_TOOLS]:tools,[CAPTURE_TRACE]:trace,...asks},exactRects:options.exactRects??[]};
}
function* photoSteps(data,width,height,options,band,large=false,reading=options.captureReading){
  const {colorSpace,quality,effort,tools,trace,asks,level,exactRects:rects}=admitted(data,width,height,options,large?BANDED_LIMITS:undefined),{signal,photoAdmission}=options;
  const exactFile=from=>within(band?captureBandSteps(data,width,height,{...band,...level,colorSpace,maxError:0,signal}):encodeCaptureSteps(data,width,height,{...level,colorSpace,maxError:0,signal}),from,1-from);
  if(quality===100)return yield* exactFile(0);
  const top=band?.y??0,exactRects=rects.filter(e=>e.edge!==true).map(e=>({...e,y:e.y-top})).filter(e=>e.y<height&&e.y+e.height>0),photoRects=(options.photoRects??[]).map(e=>({...e,y:e.y-top}));
  const photoSubjects=(options.photoSubjects??options.photoRects??[]).map(e=>({...e,y:e.y-top}));
  let regions=options.regions??(yield* unit('photo-regions',()=>capturePhotoRegions(data,width,height,photoRects,exactRects))),exact=null;
  check(signal);
  const small=width*height<SMALL,flat=yield* unit('flat',()=>flatSamples(data,width,height)<=32);
  if(small&&flat)exact=yield* within(exactFile(0),0,0.4);
  const whole=!large&&flat&&!(yield* unit('text-like',()=>textLike(data,width,height)))&&(exact?dense(exact.length,width*height):covers(regions,width,height)||(yield* denseStrips(data,width,height,{...level,colorSpace,maxError:0,signal},0)));
  if(whole&&exactRects.length&&band&&!band.shape.alpha)return exact??(yield* exactFile(0));
  if(whole&&!exactRects.length){
    const own=options.regionQuality?.(data,width,{x:0,y:0,width,height},false,colorSpace)??quality;
    const measuredCrops=photoAdmission&&options.photoBlocks&&(options.photoBlockEffort??effort??DEFAULT_EFFORT)>=4&&photoSubjects.some(r=>r.x>0||r.y>0||r.x+r.width<width||r.y+r.height<height);
    if(!band&&!measuredCrops){
      const route=options.wholePhotoRoute;
      const retainFloor=route?function*(floor){if(!floor&&!exact)exact=yield* exactFile(0);}:null;
      const photo=yield* within((options.wholePhoto??lowWholePhotoSteps)(data,width,height,{quality:own,colorSpace,
        effort:route?.effort??options.photoBlockEffort??effort??DEFAULT_EFFORT,
        ...(route&&{firstEffort:4,retainFloor,preview:route.preview}),readingWebp:options.readingWebp,signal,
        photoAdmission,photoSearch:options.photoSearch}),exact?0.4:0,exact?0.6:1);
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
    if(options.photoBlocks){
      const rows=(y,count)=>data.subarray(y*width*4,(y+count)*width*4);
      const frame={quality:own,colorSpace,placement,effort:options.photoBlockEffort??effort,readingWebp:options.readingWebp,signal,photoAdmission,
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
  let graphics=yield* unit('graphic-regions',()=>captureGraphicRegions(data,width,height,photoRects,exactRects));
  if(graphics.length){
    const covered=r=>graphics.reduce((s,g)=>{if(!g.palette)return s;const w=Math.min(r.x+r.width,g.x+g.width)-Math.max(r.x,g.x),h=Math.min(r.y+r.height,g.y+g.height)-Math.max(r.y,g.y);return s+(w>0&&h>0?w*h:0);},0)>=HINTED*r.width*r.height;
    regions=regions.filter(r=>!covered(r));graphics=graphics.filter(g=>!regions.some(r=>meets(g,r)));
  }
  if(!band&&exactRects.length&&(regions.length||graphics.length)&&(yield* unit('opaque',()=>photoKernels().opaque(data,width,0,0,width,height)))){
    const read=(r,offGrid)=>options.regionQuality?.(data,width,r,offGrid,colorSpace)??quality;
    const look=options.look&&(effort??3)>=4&&options.readingWebp!==undefined?options.look:null;
    const qualityOf=look?Object.assign((r,offGrid,dx,dy)=>look(data,width,r,read(r,offGrid),options.readingWebp,dx,dy,exactRects,colorSpace,quality,photoRects),
      {steps:look.steps&&((r,offGrid,dx,dy)=>look.steps(data,width,r,read(r,offGrid),options.readingWebp,dx,dy,exactRects,colorSpace,quality,photoRects))}):read;
    const lossy=[...regions,...graphics];
    const baseline=large?null:function*(pieces,regions){
      const reading={pieces,exact:true,requirePieces:true};
      const bytes=yield* photoSteps(data,width,height,{...options,wholePhotoRoute:null,exactRects:[],photoRects:[],photoSubjects:photoAdmission?photoSubjects:[],regions},undefined,false,reading);
      return {bytes,exact:reading.exact,wholePhoto:reading.wholePhoto===true};
    };
    const page=yield* within(patchedPageSteps(data,width,height,{quality,regions:lossy,unconfirmed:graphics.length>0,qualityOf,exactRects,colorSpace,exactOptions:{...level,signal},
      photoBlocks:options.photoBlocks,photoBlockEffort:options.photoBlockEffort,readingWebp:options.readingWebp,photoRects:photoSubjects,photoAdmission,photoScoreMemo:options.photoScoreMemo,baseline,textReading:options.textReading,[CAPTURE_PROTECTION]:options[CAPTURE_PROTECTION]}),exact?0.4:0,exact?0.6:1);
    if(page){
      check(signal);return exact&&(exact.length<=page.length||photoAdmission&&!photoAdmission.accepts(page))?exact:page;
    }
  }
  if(large)return null;
  const sparse=[...regions,...graphics].reduce((s,r)=>s+r.width*r.height,0)*8<width*height;
  const mixedReading=reading&&{pieces:reading.pieces,exact:true,requirePieces:reading.requirePieces&&!exact&&!sparse};
  const at=exact?0.4:0,mixed=regions.length||graphics.length?yield* composeCapturePhotoSteps(data,width,height,quality,colorSpace,regions,{signal,band,effort,tools,trace,asks,exactRects,graphics,from:at,regionQuality:options.regionQuality,photos:photoSubjects,reading:mixedReading,
    photoBlocks:options.photoBlocks,photoBlockEffort:options.photoBlockEffort,readingWebp:options.readingWebp,photoAdmission,[CAPTURE_PROTECTION]:options[CAPTURE_PROTECTION],...(options.unionCap&&{unionCap:options.unionCap})}):null;
  if(mixedReading?.requirePieces&&mixedReading.exact===false){reading.exact=false;return null;}
  if(mixed&&!exact&&sparse){
    const {bytes,pixels}=yield* stripBytes(data,width,height,{...level,colorSpace,maxError:0,signal},1);
    if(!pixels||mixed.length*pixels>=bytes*width*height)exact=yield* exactFile(1);
  }
  const result=!mixed||exact&&(exact.length<=mixed.length||photoAdmission&&!photoAdmission.accepts(mixed))?exact??(yield* exactFile(at)):mixed;
  if(reading&&result===mixed)reading.exact&&=mixedReading.exact;
  return result;
}
export const encodeCapturePhotoSteps=(data,width,height,options={})=>photoSteps(data,width,height,options);
export const encodeCapturePhotoBytes=(data,width,height,options={})=>drain(photoSteps(data,width,height,options));
export const capturePatchedLargeSteps=(data,width,height,options={})=>photoSteps(data,width,height,options,undefined,true);
export const capturePhotoBandSteps=(data,width,height,options)=>photoSteps(data,width,height,options,
  {y:options.y,imageHeight:options.imageHeight,shape:options.quality===100?options.shape:{...options.shape,colour:3}});
export const capturePhotoBand=(data,width,height,options)=>drain(capturePhotoBandSteps(data,width,height,options));

