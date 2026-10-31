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

export function composeFrame(frame,h,f,references,inPlace=false) {
  const colors=frame.planes.length, source=channels(frame), count=source.length;
  const width=h.width,height=h.height,exact=f.x0===0&&f.y0===0&&frame.width===width&&frame.height===height;
  const replace=c=>f.blending[c<colors?0:c-colors+1].mode===0;
  const base=inPlace?references[f.blending[0].source]:null;
  if(base)requireDecode(base.width===width&&base.height===height&&!(base.x0??0)&&!(base.y0??0)&&base.planes.length===colors&&channels(base).length===count,'JPEG XL frame blending needs a full canvas.');
  const planes=base?channels(base):source.map((p,c)=>exact&&replace(c)?p:new Float32Array(width*height));
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
  for(let c=0;c<count;c++)if(replace(c)&&planes[c]!==source[c]&&x1>x0){
    const src=source[c],dst=planes[c],fw=frame.width,fx0=f.x0,fy0=f.y0,span=x1-x0;
    if(fx0===0&&fw===width&&span===width) {
      dst.set(src.subarray((y0-fy0)*fw,(y1-fy0)*fw),y0*width);
    } else {
      for(let y=y0;y<y1;y++)dst.set(src.subarray((y-fy0)*fw+x0-fx0,(y-fy0)*fw+x1-fx0),y*width+x0);
    }
  }
  const span=x1-x0,blended=[];
  for(let c=0;c<count;c++) {
    if(replace(c))continue;
    const blend=f.blending[c<colors?0:c-colors+1];let mode=modes[blend.mode];
    const useAlpha=alphaCount>0&&(c>=colors||hasAlpha)&&(blend.mode===2||blend.mode===3);
    if(!useAlpha&&mode>=4)mode=mode===4?1:2;
    const a=blend.alpha,reference=useAlpha?references[blend.source]:null,fa=useAlpha?frame.extraChannels[a].data:null;
    const ba=reference?.extraChannels[a].data,rx0=reference?.x0??0,ry0=reference?.y0??0;
    blended.push({mode,clamp:blend.clamp,associated:useAlpha&&h.extraChannels[a].associated,isAlpha:useAlpha&&c===colors+a,
      fill(role,row,run) {
        const y=y0+row,from=(y-f.y0)*frame.width+x0-f.x0;
        if(role===0)run.set(planes[c].subarray(y*width+x0,y*width+x1));
        else if(role===1)run.set(source[c].subarray(from,from+span));
        else if(!useAlpha)return;
        else if(role===3)run.set(fa.subarray(from,from+span));
        else {
          run.fill(0);
          const ry=y-ry0,a0=Math.max(x0,rx0),a1=Math.min(x1,rx0+(reference?.width??0));
          if(reference&&ry>=0&&ry<reference.height&&a1>a0)run.set(ba.subarray(ry*reference.width+a0-rx0,ry*reference.width+a1-rx0),a0-x0);
        }
      },
      write(row,run){planes[c].set(run,(y0+row)*width+x0);}});
  }
  if(span>0)blendRows(blended,y1-y0,span);
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
