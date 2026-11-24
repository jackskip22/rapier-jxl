// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {decodeKernels} from './decode-kernels.mjs';

const modes=[1,2,4,6,3];
const channels=frame=>[...frame.planes,...frame.extraChannels.map(c=>c.data)];

const ROLES=4;
export function blendRows(channels,rows,span) {
  const count=channels.length;
  if(!count||rows<=0||span<=0)return;
  const kernels=decodeKernels(),chunk=Math.max(1,Math.min(rows,Math.floor(2097152/(count*(ROLES+1)*span)))),n=chunk*span;
  const at=kernels.reserve([count*32,...Array(count*(ROLES+1)).fill(n*4)]),runs=k=>new Float32Array(kernels.buffer,at[1+k],n);
  channels.forEach((c,i)=>kernels.i32.set([at[1+i*(ROLES+1)],...[1,2,3,4].map(r=>at[1+i*(ROLES+1)+r]),c.mode,(c.clamp?1:0)|(c.associated?2:0)|(c.isAlpha?4:0)],(at[0]>>2)+i*8));
  for(let y0=0;y0<rows;y0+=chunk) {
    const m=Math.min(chunk,rows-y0);
    channels.forEach((c,i)=>{for(let r=0;r<ROLES;r++){const run=runs(i*(ROLES+1)+1+r);for(let y=0;y<m;y++)c.fill(r,y0+y,run.subarray(y*span,(y+1)*span));}});
    kernels.blend(m*span,at[0],count);
    channels.forEach((c,i)=>{const out=runs(i*(ROLES+1));for(let y=0;y<m;y++)c.write(y0+y,out.subarray(y*span,(y+1)*span));});
  }
}

function blendCanvas(items,alphaGroups,x0,x1,y0,y1,width,f) {
  const count=items.length,rows=y1-y0,span=x1-x0;
  if(!count||rows<=0||span<=0)return;
  const kernels=decodeKernels(),bufCount=alphaGroups.length*2+count*2;
  const chunk=Math.max(1,Math.min(rows,Math.floor(2097152/(Math.max(1,bufCount)*span)))),n=chunk*span;
  const sizes=[count*32];
  for(const ag of alphaGroups){ag.baSlot=sizes.length;sizes.push(n*4);ag.faSlot=sizes.length;sizes.push(n*4);}
  for(const it of items) {
    if(it.ag&&it.plane===it.ag.ba){it.bgSlot=it.ag.baSlot;it.ownBg=false;it.outSlot=sizes.length;sizes.push(n*4);}
    else{it.bgSlot=sizes.length;sizes.push(n*4);it.ownBg=true;it.outSlot=it.bgSlot;}
    if(it.ag&&it.src===it.ag.fa){it.fgSlot=it.ag.faSlot;it.ownFg=false;}
    else{it.fgSlot=sizes.length;sizes.push(n*4);it.ownFg=true;}
  }
  const at=kernels.reserve(sizes),specsAt=at[0],fw=frameWidth(f,items);
  for(const ag of alphaGroups){
    ag.baAt=at[ag.baSlot];ag.faAt=at[ag.faSlot];
    ag.baView=new Float32Array(kernels.buffer,ag.baAt,n);ag.faView=new Float32Array(kernels.buffer,ag.faAt,n);
  }
  for(let i=0;i<count;i++) {
    const it=items[i],bgAt=at[it.bgSlot],fgAt=at[it.fgSlot],outAt=at[it.outSlot];
    const baAt=it.ag?it.ag.baAt:bgAt,faAt=it.ag?it.ag.faAt:bgAt;
    kernels.i32.set([outAt,bgAt,fgAt,baAt,faAt,it.mode,it.flags],(specsAt>>2)+i*8);
    if(it.ownBg)it.bgView=new Float32Array(kernels.buffer,bgAt,n);
    if(it.ownFg)it.fgView=new Float32Array(kernels.buffer,fgAt,n);
    it.outView=new Float32Array(kernels.buffer,outAt,n);
  }
  const dx=x0-f.x0;
  for(let cy=0;cy<rows;cy+=chunk) {
    const m=Math.min(chunk,rows-cy),samples=m*span,sy=y0+cy-f.y0;
    for(let g=0;g<alphaGroups.length;g++) {
      const ag=alphaGroups[g];
      if(span===fw){const off=sy*fw+dx;ag.faView.set(ag.fa.subarray(off,off+samples));}
      else for(let r=0;r<m;r++){const off=(sy+r)*fw+dx;ag.faView.set(ag.fa.subarray(off,off+span),r*span);}
      const ref=ag.reference;
      if(ref&&ag.rx0<=x0&&ag.rx0+ref.width>=x1&&ag.ry0<=y0+cy&&ag.ry0+ref.height>=y0+cy+m) {
        const rw=ref.width,rdx=x0-ag.rx0,rsy=y0+cy-ag.ry0;
        if(span===rw){const off=rsy*rw+rdx;ag.baView.set(ag.ba.subarray(off,off+samples));}
        else for(let r=0;r<m;r++){const off=(rsy+r)*rw+rdx;ag.baView.set(ag.ba.subarray(off,off+span),r*span);}
      } else {
        ag.baView.fill(0,0,samples);
        if(ref) {
          const a0=Math.max(x0,ag.rx0),a1=Math.min(x1,ag.rx0+ref.width),rw=ref.width;
          if(a1>a0)for(let r=0;r<m;r++){
            const ry=y0+cy+r-ag.ry0;
            if(ry>=0&&ry<ref.height)ag.baView.set(ag.ba.subarray(ry*rw+a0-ag.rx0,ry*rw+a1-ag.rx0),r*span+a0-x0);
          }
        }
      }
    }
    for(let i=0;i<count;i++) {
      const it=items[i];
      if(it.ownBg) {
        if(span===width){const off=(y0+cy)*width+x0;it.bgView.set(it.plane.subarray(off,off+samples));}
        else for(let r=0;r<m;r++){const off=(y0+cy+r)*width+x0;it.bgView.set(it.plane.subarray(off,off+span),r*span);}
      }
      if(it.ownFg) {
        if(span===fw){const off=sy*fw+dx;it.fgView.set(it.src.subarray(off,off+samples));}
        else for(let r=0;r<m;r++){const off=(sy+r)*fw+dx;it.fgView.set(it.src.subarray(off,off+span),r*span);}
      }
    }
    kernels.blend(samples,specsAt,count);
    for(let i=0;i<count;i++) {
      const it=items[i];
      if(span===width)it.plane.set(it.outView.subarray(0,samples),(y0+cy)*width+x0);
      else for(let r=0;r<m;r++)it.plane.set(it.outView.subarray(r*span,(r+1)*span),(y0+cy+r)*width+x0);
    }
  }
}
const frameWidth=(f,items)=>f._fw;

export function composeFrame(frame,h,f,references,inPlace=false,owned=false) {
  const colors=frame.planes.length, source=channels(frame), count=source.length;
  const width=h.width,height=h.height,exact=f.x0===0&&f.y0===0&&frame.width===width&&frame.height===height;
  const replace=c=>f.blending[c<colors?0:c-colors+1].mode===0;
  const base=inPlace?references[f.blending[0].source]:null;
  const cutInside=owned&&!base&&!exact&&f.x0<=0&&f.y0<=0&&f.x0+frame.width>=width&&f.y0+frame.height>=height&&source.every((_,c)=>replace(c));
  if(base)requireDecode(base.width===width&&base.height===height&&!(base.x0??0)&&!(base.y0??0)&&base.planes.length===colors&&channels(base).length===count,'JPEG XL frame blending needs a full canvas.');
  const planes=base?channels(base):source.map((p,c)=>exact&&replace(c)||cutInside?p:new Float32Array(width*height));
  const alphaCount=h.extraChannels.length, hasAlpha=h.extraChannels.some(e=>e.type===0);
  const coversCanvas=f.x0<=0&&f.y0<=0&&f.x0+frame.width>=width&&f.y0+frame.height>=height;
  for(let c=0;c<count;c++) {
    const blend=f.blending[c<colors?0:c-colors+1], reference=base||blend.mode===0&&coversCanvas?null:references[blend.source];
    if(reference) {
      requireDecode(!reference.saveBeforeColorTransform,'JPEG XL frame blending needs a post-color reference.');
      requireDecode(reference.planes.length===colors,'JPEG XL frame reference color channels disagree.');
      const input=c<colors?reference.planes[c]:reference.extraChannels[c-colors].data;
      if(planes[c]===input)continue;
      const ox=reference.x0??0,oy=reference.y0??0;
      if(ox===0&&oy===0&&reference.width===width&&reference.height===height) {
        planes[c].set(input);
      } else {
        const x0=Math.max(0,ox),y0=Math.max(0,oy),x1=Math.min(width,ox+reference.width),y1=Math.min(height,oy+reference.height);
        for(let y=y0;y<y1;y++) planes[c].set(input.subarray((y-oy)*reference.width+x0-ox,(y-oy)*reference.width+x1-ox),y*width+x0);
      }
    }
  }
  const x0=Math.max(0,f.x0),y0=Math.max(0,f.y0),x1=Math.min(width,f.x0+frame.width),y1=Math.min(height,f.y0+frame.height);
  if(cutInside) {
    for(let c=0;c<count;c++) {
      const p=source[c];
      for(let y=0;y<height;y++) {const from=(y-f.y0)*frame.width-f.x0;p.copyWithin(y*width,from,from+width);}
      planes[c]=p.subarray(0,width*height);
    }
  }
  for(let c=0;c<count;c++)if(!cutInside&&replace(c)&&planes[c]!==source[c]&&x1>x0){
    const src=source[c],dst=planes[c],fw=frame.width,fx0=f.x0,fy0=f.y0,span=x1-x0;
    if(fx0===0&&fw===width&&span===width) {
      dst.set(src.subarray((y0-fy0)*fw,(y1-fy0)*fw),y0*width);
    } else {
      for(let y=y0;y<y1;y++)dst.set(src.subarray((y-fy0)*fw+x0-fx0,(y-fy0)*fw+x1-fx0),y*width+x0);
    }
  }
  if(x1>x0&&y1>y0) {
    const items=[],alphaGroups=[],alphaMap=new Map();
    for(let c=0;c<count;c++) {
      if(replace(c))continue;
      const blend=f.blending[c<colors?0:c-colors+1];let mode=modes[blend.mode];
      const useAlpha=alphaCount>0&&(c>=colors||hasAlpha)&&(blend.mode===2||blend.mode===3);
      if(!useAlpha&&mode>=4)mode=mode===4?1:2;
      const a=blend.alpha;
      let ag=null;
      if(useAlpha) {
        const key=blend.source*65536+a;
        ag=alphaMap.get(key);
        if(!ag) {
          const reference=references[blend.source];
          ag={reference,fa:frame.extraChannels[a].data,ba:reference?.extraChannels[a].data,rx0:reference?.x0??0,ry0:reference?.y0??0};
          alphaMap.set(key,ag);alphaGroups.push(ag);
        }
      }
      const flags=(blend.clamp?1:0)|(useAlpha&&h.extraChannels[a].associated?2:0)|(useAlpha&&c===colors+a?4:0);
      items.push({plane:planes[c],src:source[c],mode,flags,ag});
    }
    if(items.length)blendCanvas(items,alphaGroups,x0,x1,y0,y1,width,{x0:f.x0,y0:f.y0,_fw:frame.width});
  }
  return {...frame,width,height,widths:frame.planes.map(()=>width),heights:frame.planes.map(()=>height),x0:0,y0:0,
    planes:planes.slice(0,colors),extraChannels:frame.extraChannels.map((e,c)=>({...e,width,height,data:planes[colors+c]})),saveBeforeColorTransform:false};
}

export function orientPlane(input,width,height,orientation) {
  if(orientation===1)return input;
  const output=new Float32Array(input.length),dw=orientation>=5?height:width,transpose=orientation>=5,flipped=[3,4,6,7].includes(orientation);
  const kernels=decodeKernels(),rows=Math.max(1,Math.min(height,Math.floor(1048576/Math.max(1,width)))),[stripe,oriented]=kernels.reserve([rows*width*4,rows*width*4]);
  for(let a=0;a<height;a+=rows) {
    const b=Math.min(height,a+rows),n=b-a,first=flipped?height-b:a;
    new Float32Array(kernels.buffer,stripe,n*width).set(input.subarray(a*width,b*width));
    kernels.orient(stripe,width,height,a,b,orientation,oriented,transpose?n:width,transpose?first:0,transpose?0:first);
    const result=new Float32Array(kernels.buffer,oriented,n*width);
    if(!transpose)output.set(result,first*width);
    else for(let y=0;y<width;y++)output.set(result.subarray(y*n,(y+1)*n),y*dw+first);
  }
  return output;
}

export function orientFrame(frame,orientation) {
  if(orientation===1)return frame;
  const width=orientation>=5?frame.height:frame.width,height=orientation>=5?frame.width:frame.height;
  return {...frame,width,height,widths:frame.planes.map(()=>width),heights:frame.planes.map(()=>height),
    planes:frame.planes.map(p=>orientPlane(p,frame.width,frame.height,orientation)),
    extraChannels:frame.extraChannels.map(e=>({...e,width,height,data:orientPlane(e.data,frame.width,frame.height,orientation)}))};
}

const FORMAT={uint8:0,uint16:1,float32:2},RGBA_CHUNK=65536;
export function rgbaPixels(frame,format,unpremultiplyAlpha=false,renderSpotColors=false,target=null,scratch=null) {
  const count=frame.width*frame.height,alpha=frame.extraChannels.find(e=>e.type===0),gray=frame.planes.length===1;
  const data=target??(format==='float32'?new Float32Array(count*4):format==='uint16'?new Uint16Array(count*4):new Uint8Array(count*4));
  const spots=renderSpotColors?frame.extraChannels.filter(e=>e.type===2):[],kernels=decodeKernels();
  const planes=[frame.planes[0],frame.planes[gray?0:1],frame.planes[gray?0:2],...(alpha?[alpha.data]:[]),...spots.map(s=>s.data)];
  const un=unpremultiplyAlpha&&alpha?.associated?1:0,size=data.BYTES_PER_ELEMENT;
  const run=(n,inputs,out,list)=>{
    const g=kernels.args/4;
    spots.forEach((spot,k)=>{const at=list+k*40;kernels.i32[at/4]=inputs[3+(alpha?1:0)+k].byteOffset;kernels.f64.set(spot.spotColor.slice(0,4),at/8+1);});
    kernels.i32.set([n,FORMAT[format],inputs[0].byteOffset,inputs[1].byteOffset,inputs[2].byteOffset,alpha?inputs[3].byteOffset:0,out.byteOffset,un,spots.length,list],g);
    kernels.rgba(kernels.args);
  };
  if(planes.every(p=>p.buffer===kernels.buffer)&&!spots.length) {
    if(data.buffer===kernels.buffer){run(count,planes,data,0);return data;}
    requireDecode(scratch,'RGBA from the kernels needs scratch.');
    const rows=Math.max(1,Math.floor(scratch.bytes/(16*size)))*4,out=new data.constructor(kernels.buffer,scratch.at,rows*4);
    for(let start=0;start<count;start+=rows) {
      const n=Math.min(rows,count-start);
      run(n,planes.map(p=>p.subarray(start,start+n)),out,0);
      data.set(out.subarray(0,n*4),start*4);
    }
    return data;
  }
  const chunk=Math.min(count,RGBA_CHUNK),at=kernels.reserve([...planes.map(()=>chunk*4),chunk*4*size,spots.length*40]);
  const staged=planes.map((_,k)=>new Float32Array(kernels.buffer,at[k],chunk)),out=new data.constructor(kernels.buffer,at.at(-2),chunk*4);
  for(let start=0;start<count;start+=chunk) {
    const n=Math.min(chunk,count-start);
    planes.forEach((p,k)=>staged[k].set(p.subarray(start,start+n)));
    run(n,staged,out,at.at(-1));
    data.set(out.subarray(0,n*4),start*4);
  }
  return data;
}

export function rgbaPixelsRects(frame,rects,dst) {
  if(!rects.length)return dst;
  const fw=frame.width,fh=frame.height;
  if(rects.length===1&&rects[0][0]===0&&rects[0][2]===fw&&rects[0][1]===0&&rects[0][3]===fh)return rgbaPixels(frame,'uint8',false,false,dst);
  const alpha=frame.extraChannels.find(e=>e.type===0),gray=frame.planes.length===1,kernels=decodeKernels();
  const planes=[frame.planes[0],frame.planes[gray?0:1],frame.planes[gray?0:2],...(alpha?[alpha.data]:[])],pCount=planes.length;
  let total=0;
  for(let i=0;i<rects.length;i++)total+=rects[i][2]*rects[i][3];
  if(!total)return dst;
  const cap=Math.min(RGBA_CHUNK,Math.max(fw,total));
  const at=kernels.reserve([...planes.map(()=>cap*4),cap*4]);
  const staged=planes.map((_,k)=>new Float32Array(kernels.buffer,at[k],cap)),out=new Uint8Array(kernels.buffer,at.at(-1),cap*4);
  const g=kernels.args/4,spans=[];
  let filled=0;
  const flush=()=>{
    if(!filled)return;
    kernels.i32.set([filled,0,staged[0].byteOffset,staged[1].byteOffset,staged[2].byteOffset,alpha?staged[3].byteOffset:0,out.byteOffset,0,0,0],g);
    kernels.rgba(kernels.args);
    for(let i=0;i<spans.length;i+=3)dst.set(out.subarray(spans[i]*4,(spans[i]+spans[i+1])*4),spans[i+2]*4);
    spans.length=0;filled=0;
  };
  for(let i=0;i<rects.length;i++) {
    const [x0,y0,width,height]=rects[i];
    if(width<=0||height<=0)continue;
    if(x0===0&&width===fw) {
      let row=0;
      while(row<height) {
        const take=Math.min(height-row,Math.floor((cap-filled)/fw));
        if(!take){flush();continue;}
        const n=take*fw,sOff=(y0+row)*fw;
        for(let k=0;k<pCount;k++)staged[k].set(planes[k].subarray(sOff,sOff+n),filled);
        spans.push(filled,n,sOff);
        filled+=n;row+=take;
      }
    } else {
      for(let r=0;r<height;r++) {
        if(filled+width>cap)flush();
        const sOff=(y0+r)*fw+x0;
        for(let k=0;k<pCount;k++)staged[k].set(planes[k].subarray(sOff,sOff+width),filled);
        spans.push(filled,width,sOff);
        filled+=width;
      }
    }
  }
  flush();
  return dst;
}
export function rgbaPixelsRect(frame,x0,y0,width,height,dst) {
  return width>0&&height>0?rgbaPixelsRects(frame,[[x0,y0,width,height]],dst):dst;
}
