// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {decodeKernels} from './decode-kernels.mjs';

const modes=[1,2,4,6,3];
const channels=frame=>[...frame.planes,...frame.extraChannels.map(c=>c.data)];

const f32=Math.fround,clamp01=x=>Math.max(0,Math.min(1,x));
export function blendSample(background, foreground, backgroundAlpha, foregroundAlpha, blend, associated = false, isAlpha = false) {
  const {mode, clamp} = blend;
  if (mode === 0) return background;
  if (mode === 1) return foreground;
  if (mode === 2) return f32(background + foreground);
  if (mode === 3) return f32(background * (clamp ? clamp01(foreground) : foreground));
  if (mode === 5 || mode === 7) {
    [background, foreground] = [foreground, background];
    [backgroundAlpha, foregroundAlpha] = [foregroundAlpha, backgroundAlpha];
  }
  const alpha = clamp ? clamp01(foregroundAlpha) : foregroundAlpha;
  if (mode >= 6) return isAlpha ? background : f32(background + f32(alpha * foreground));
  const remaining = f32(1 - alpha), mergedAlpha = f32(1 - f32(remaining * f32(1 - backgroundAlpha)));
  if (isAlpha) return mergedAlpha;
  if (associated) return f32(foreground + f32(background * remaining));
  const contribution = f32(f32(foreground * alpha) + f32(f32(background * backgroundAlpha) * remaining));
  return f32(contribution * (mergedAlpha > 0 ? f32(1 / mergedAlpha) : 0));
}

export function composeFrame(frame,h,f,references) {
  const colors=frame.planes.length, source=channels(frame), count=source.length;
  const width=h.width,height=h.height,exact=f.x0===0&&f.y0===0&&frame.width===width&&frame.height===height;
  const replace=c=>f.blending[c<colors?0:c-colors+1].mode===0;
  const planes=source.map((p,c)=>exact&&replace(c)?p:new Float32Array(width*height));
  const alphaCount=h.extraChannels.length, hasAlpha=h.extraChannels.some(e=>e.type===0);
  const coversCanvas=f.x0<=0&&f.y0<=0&&f.x0+frame.width>=width&&f.y0+frame.height>=height;
  for(let c=0;c<count;c++) {
    const blend=f.blending[c<colors?0:c-colors+1], reference=blend.mode===0&&coversCanvas?null:references[blend.source];
    if(reference) {
      requireDecode(!reference.saveBeforeColorTransform,'JPEG XL frame blending needs a post-color reference.');
      requireDecode(reference.planes.length===colors,'JPEG XL frame reference color channels disagree.');
      const input=c<colors?reference.planes[c]:reference.extraChannels[c-colors].data;
      const ox=reference.x0??0,oy=reference.y0??0;
      const x0=Math.max(0,ox),y0=Math.max(0,oy),x1=Math.min(width,ox+reference.width),y1=Math.min(height,oy+reference.height);
      for(let y=y0;y<y1;y++) planes[c].set(input.subarray((y-oy)*reference.width+x0-ox,(y-oy)*reference.width+x1-ox),y*width+x0);
    }
  }
  const x0=Math.max(0,f.x0),y0=Math.max(0,f.y0),x1=Math.min(width,f.x0+frame.width);let y1=Math.min(height,f.y0+frame.height);
  const values=new Float32Array(count);
  for(let c=0;c<count;c++)if(replace(c)&&planes[c]!==source[c]&&x1>x0)for(let y=y0;y<y1;y++)planes[c].set(source[c].subarray((y-f.y0)*frame.width+x0-f.x0,(y-f.y0)*frame.width+x1-f.x0),y*width+x0);
  if(source.every((_,c)=>replace(c)))y1=y0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {
    const dst=y*width+x,src=(y-f.y0)*frame.width+x-f.x0;
    for(let c=0;c<count;c++) {
      if(replace(c)){values[c]=planes[c][dst];continue;}
      const blend=f.blending[c<colors?0:c-colors+1];let mode=modes[blend.mode];
      const useAlpha=alphaCount>0&&(c>=colors||hasAlpha)&&(blend.mode===2||blend.mode===3);
      if(!useAlpha&&mode>=4)mode=mode===4?1:2;
      let ba=0,fa=0,associated=false,isAlpha=false;
      if(useAlpha) {
        const a=blend.alpha,reference=references[blend.source];fa=frame.extraChannels[a].data[src];
        if(reference) {
          const rx=x-(reference.x0??0),ry=y-(reference.y0??0);
          if(rx>=0&&ry>=0&&rx<reference.width&&ry<reference.height)ba=reference.extraChannels[a].data[ry*reference.width+rx];
        }
        associated=h.extraChannels[a].associated;isAlpha=c===colors+a;
      }
      values[c]=blendSample(planes[c][dst],source[c][src],ba,fa,{mode,clamp:blend.clamp},associated,isAlpha);
    }
    for(let c=0;c<count;c++)planes[c][dst]=values[c];
  }
  return {...frame,width,height,widths:frame.planes.map(()=>width),heights:frame.planes.map(()=>height),x0:0,y0:0,
    planes:planes.slice(0,colors),extraChannels:frame.extraChannels.map((e,c)=>({...e,width,height,data:planes[colors+c]})),saveBeforeColorTransform:false};
}

export function orientPlane(input,width,height,orientation) {
  if(orientation===1)return input;
  const output=new Float32Array(input.length),dw=orientation>=5?height:width;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    let ox=x,oy=y;
    if(orientation===2)ox=width-1-x;
    else if(orientation===3){ox=width-1-x;oy=height-1-y;}
    else if(orientation===4)oy=height-1-y;
    else if(orientation===5){ox=y;oy=x;}
    else if(orientation===6){ox=height-1-y;oy=x;}
    else if(orientation===7){ox=height-1-y;oy=width-1-x;}
    else if(orientation===8){ox=y;oy=width-1-x;}
    output[oy*dw+ox]=input[y*width+x];
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

export function rgbaPixels(frame,format,unpremultiplyAlpha=false,renderSpotColors=false,target=null) {
  const count=frame.width*frame.height,alpha=frame.extraChannels.find(e=>e.type===0);
  const data=target??(format==='float32'?new Float32Array(count*4):format==='uint16'?new Uint16Array(count*4):new Uint8Array(count*4));
  const maximum=format==='uint16'?65535:255,gray=frame.planes.length===1;
  const spots=renderSpotColors?frame.extraChannels.filter(e=>e.type===2):[];
  if(!spots.length&&!(unpremultiplyAlpha&&alpha?.associated)) {
    const r=frame.planes[0],g=frame.planes[gray?0:1],b=frame.planes[gray?0:2],a=alpha?.data,kernels=decodeKernels();
    if(kernels&&format==='uint8'&&!a&&[r,g,b,data].every(p=>p.buffer===kernels.buffer)){kernels.rgba8(count,r,g,b,data);return data;}
    if(format==='float32')for(let i=0,o=0;i<count;i++,o+=4){data[o]=r[i];data[o+1]=g[i];data[o+2]=b[i];data[o+3]=a?a[i]:1;}
    else {
      const top=maximum+.5,q=v=>{const t=v*maximum+.5;return t>=top?maximum:t>=1?Math.floor(t):0;};
      for(let i=0,o=0;i<count;i++,o+=4){data[o]=q(r[i]);data[o+1]=q(g[i]);data[o+2]=q(b[i]);data[o+3]=a?q(a[i]):maximum;}
    }
    return data;
  }
  for(let i=0;i<count;i++) {
    const a=alpha?alpha.data[i]:1;
    for(let c=0;c<3;c++) {
      let v=frame.planes[gray?0:c][i];
      if(unpremultiplyAlpha&&alpha?.associated)v=a>0?v/a:0;
      for(const spot of spots){const mix=spot.data[i]*spot.spotColor[3];v=v*(1-mix)+spot.spotColor[c]*mix;}
      data[4*i+c]=format==='float32'?v:Math.max(0,Math.min(maximum,Math.round(v*maximum)));
    }
    data[4*i+3]=format==='float32'?a:Math.max(0,Math.min(maximum,Math.round(a*maximum)));
  }
  return data;
}
