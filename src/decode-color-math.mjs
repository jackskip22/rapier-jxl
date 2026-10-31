// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {exactPow, exactLog} from './exact-math.mjs';
import {CURVE} from './decode-color-program.mjs';
import {decodeKernels} from './decode-kernels.mjs';

export const IDENTITY3 = Object.freeze([1,0,0, 0,1,0, 0,0,1]);
export const D50 = Object.freeze([0.9642,1,0.8249]);
const WHITE = {d65:[0.3127,0.329],dci:[0.314,0.351],e:[1/3,1/3],d50:[0.345669,0.358496]};
const PRIMARIES = {
  srgb:[[0.639998686,0.330010138],[0.300003784,0.600003357],[0.150002046,0.059997204]],
  'display-p3':[[0.680,0.320],[0.265,0.690],[0.150,0.060]],
  rec2020:[[0.708,0.292],[0.170,0.797],[0.131,0.046]],
};
export function inverse3(m) {
  const a=m[0],b=m[1],c=m[2],d=m[3],e=m[4],f=m[5],g=m[6],h=m[7],i=m[8];
  const p=e*i-f*h,q=f*g-d*i,r=d*h-e*g,det=a*p+b*q+c*r;
  requireDecode(Number.isFinite(det)&&Math.abs(det)>1e-20,'Singular JPEG XL color matrix.');
  return [p,c*h-b*i,b*f-c*e,q,a*i-c*g,c*d-a*f,r,b*g-a*h,a*e-b*d].map(v=>v/det);
}
export function multiply3(a,b) {
  const out=new Array(9);
  for(let y=0;y<3;y++)for(let x=0;x<3;x++)out[y*3+x]=a[y*3]*b[x]+a[y*3+1]*b[x+3]+a[y*3+2]*b[x+6];
  return out;
}
export function vector3(m,v,out=v) {
  const x=v[0],y=v[1],z=v[2];
  out[0]=m[0]*x+m[1]*y+m[2]*z;out[1]=m[3]*x+m[4]*y+m[5]*z;out[2]=m[6]*x+m[7]*y+m[8]*z;
  return out;
}
export function whiteXYZ(white='d65') {
  const xy=Array.isArray(white)?white:WHITE[white];
  requireDecode(xy?.length===2&&xy.every(Number.isFinite)&&xy[1]!==0,'Invalid JPEG XL color white point.');
  return [xy[0]/xy[1],1,(1-xy[0]-xy[1])/xy[1]];
}
const BRADFORD=[0.8951,0.2664,-0.1614,-0.7502,1.7135,0.0367,0.0389,-0.0685,1.0296];
const BRADFORD_INV=inverse3(BRADFORD);
export function adaptWhite(from,to) {
  if(from.every((v,i)=>v===to[i]))return IDENTITY3;
  const a=vector3(BRADFORD,from,[]),b=vector3(BRADFORD,to,[]);
  requireDecode(a.every(v=>Number.isFinite(v)&&v!==0)&&b.every(Number.isFinite),'Invalid JPEG XL chromatic adaptation.');
  return multiply3(BRADFORD_INV,BRADFORD.map((v,i)=>v*b[Math.floor(i/3)]/a[Math.floor(i/3)]));
}
export function primariesXYZ(primaries='srgb',white='d65') {
  const xy=Array.isArray(primaries)?primaries:PRIMARIES[primaries];
  requireDecode(xy?.length===3&&xy.every(p=>p?.length===2&&p.every(Number.isFinite)),'Invalid JPEG XL color primaries.');
  const m=[xy[0][0],xy[1][0],xy[2][0],xy[0][1],xy[1][1],xy[2][1],...xy.map(p=>1-p[0]-p[1])];
  const scale=vector3(inverse3(m),whiteXYZ(white),[]);
  return m.map((v,i)=>v*scale[i%3]);
}
export const SRGB_XYZ=Object.freeze(primariesXYZ());
export const SRGB_D50=Object.freeze(multiply3(adaptWhite(whiteXYZ(),D50),SRGB_XYZ));
export const D50_SRGB=Object.freeze(inverse3(SRGB_D50));

export function floatColorMatrix(primaries='srgb',white='d65') {
  const f=Math.fround,p=(Array.isArray(primaries)?primaries:PRIMARIES[primaries]).map(v=>v.map(f)),w=(Array.isArray(white)?white:WHITE[white]).map(f);
  const xyzWhite=[f(w[0]/w[1]),1,f(f(f(1-w[0])-w[1])/w[1])];
  const chroma=[p[0][0],p[1][0],p[2][0],p[0][1],p[1][1],p[2][1],...p.map(v=>f(f(1-v[0])-v[1]))];
  const weights=vector3(inverse3(chroma).map(f),xyzWhite,[]).map(f),xyz=chroma.map((v,i)=>f(v*weights[i%3]));
  const bradford=BRADFORD.map(f),inverse=[0.9869929,-0.1470543,0.1599627,0.4323053,0.5183603,0.0492912,-0.0085287,0.0400428,0.9684867].map(f);
  const lms=vector3(bradford,xyzWhite,[]).map(f),reference=vector3(bradford,[f(0.96422),1,f(0.82521)],[]).map(f),ratio=lms.map((v,i)=>f(reference[i]/v));
  const adaptation=multiply3(inverse,bradford.map((v,i)=>f(v*ratio[Math.floor(i/3)]))).map(f);
  return {xyz,pcs:multiply3(adaptation,xyz).map(f)};
}

export function transferCurve(encoding,inverse=false,intensityTarget=255) {
  const tf=encoding.transferFunction??(encoding.gamma===undefined?'srgb':'gamma');
  if(tf==='linear')return {kind:CURVE.linear};
  if(tf==='srgb')return {kind:inverse?CURVE.srgbInverse:CURVE.srgb};
  if(tf==='bt709')return {kind:inverse?CURVE.bt709Inverse:CURVE.bt709};
  if(tf==='gamma'||tf==='dci') {
    const exponent=tf==='dci'?1/2.6:encoding.gamma;
    requireDecode(Number.isFinite(exponent)&&exponent>0,'Invalid JPEG XL color gamma.');
    return {kind:CURVE.gamma,p:[inverse?1/exponent:exponent]};
  }
  if(tf==='pq')return {kind:inverse?CURVE.pqInverse:CURVE.pq,p:[intensityTarget]};
  if(tf==='hlg')return {kind:inverse?CURVE.hlgInverse:CURVE.hlg};
  requireDecode(false,'Cannot convert an unknown JPEG XL transfer function.');
}

export function srgb8Table() {
  const kernels=decodeKernels(),at=kernels.srgb8Table();
  return {steps:new Uint8Array(kernels.buffer,at,32768).slice(),thresholds:new Uint32Array(kernels.buffer,at+32768,257).slice()};
}

export function hlgScale(intensityTarget,inverse=false) {
  const gamma=1.2*exactPow(1.111,exactLog(intensityTarget/1000)/Math.LN2);
  return inverse?1/gamma-1:gamma-1;
}
