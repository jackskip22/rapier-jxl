// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {decodeKernels} from './decode-kernels.mjs';
import {upsampleOn} from './upsample-plane.mjs';
export function upsamplePlane(input,width,height,factor,targetWidth=width*factor,targetHeight=height*factor,custom={}) {
  if(factor===1&&width===targetWidth&&height===targetHeight)return input;
  if(factor>8){const next=factor/8,mw=Math.min(width*8,Math.ceil(targetWidth/next)),mh=Math.min(height*8,Math.ceil(targetHeight/next)),first=upsamplePlane(input,width,height,8,mw,mh,custom);return upsamplePlane(first,mw,mh,next,targetWidth,targetHeight,custom);}
  requireDecode(factor===2||factor===4||factor===8,'Invalid JPEG XL upsampling factor.');
  return upsampleOn(decodeKernels(),input,width,height,factor,targetWidth,targetHeight,custom);
}
