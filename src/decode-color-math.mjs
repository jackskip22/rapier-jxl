// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {exactPow, exactLog, exactExp} from './exact-math.mjs';

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

function signed(x,v){return x<0||Object.is(x,-0)?-v:v;}
const HLG_A=0.17883277,HLG_B=1-4*HLG_A,HLG_C=0.5599107295;
const PQ_M1=2610/16384,PQ_M2=2523/32,PQ_C1=3424/4096,PQ_C2=2413/128,PQ_C3=2392/128;

export function transferCurve(encoding,inverse=false,intensityTarget=255) {
  const tf=encoding.transferFunction??(encoding.gamma===undefined?'srgb':'gamma');
  if(tf==='linear')return x=>x;
  if(tf==='srgb')return inverse
    ?x=>{const a=Math.abs(x);return signed(x,a<=0.04045?a/12.92:exactPow((a+0.055)/1.055,2.4));}
    :x=>{const a=Math.abs(x);return signed(x,a<=0.0031308?12.92*a:1.055*exactPow(a,1/2.4)-0.055);};
  if(tf==='bt709')return inverse
    ?x=>x<0.081?x/4.5:exactPow((x+0.099)/1.099,1/0.45)
    :x=>x<0.018?4.5*x:1.099*exactPow(x,0.45)-0.099;
  if(tf==='gamma'||tf==='dci') {
    const exponent=tf==='dci'?1/2.6:encoding.gamma;
    requireDecode(Number.isFinite(exponent)&&exponent>0,'Invalid JPEG XL color gamma.');
    const g=inverse?1/exponent:exponent;
    return x=>x<=0?0:exactPow(x,g);
  }
  if(tf==='pq')return inverse
    ?x=>{if(x===0)return x;const p=exactPow(Math.abs(x),1/PQ_M2),d=PQ_C2-PQ_C3*p;return signed(x,exactPow(Math.max(p-PQ_C1,0)/d,1/PQ_M1)*10000/intensityTarget);}
    :x=>{if(x===0)return x;const p=exactPow(Math.abs(x)*intensityTarget/10000,PQ_M1);return signed(x,exactPow((PQ_C1+PQ_C2*p)/(1+PQ_C3*p),PQ_M2));};
  if(tf==='hlg')return inverse
    ?x=>{const a=Math.abs(x);return signed(x,a<=0.5?a*a/3:(exactExp((a-HLG_C)/HLG_A)+HLG_B)/12);}
    :x=>{const a=Math.abs(x);return signed(x,a<=1/12?Math.sqrt(3*a):HLG_A*exactLog(12*a-HLG_B)+HLG_C);};
  requireDecode(false,'Cannot convert an unknown JPEG XL transfer function.');
}

const SRGB_POWER=1/2.4,POW_C2=SRGB_POWER*(SRGB_POWER-1)/2,POW_C3=POW_C2*(SRGB_POWER-2)/3;
let powMantissa,powInverse,powExponent;
export function srgbTables() {
  if(!powMantissa) {
    powMantissa=new Float64Array(4096);powInverse=new Float64Array(4096);powExponent=new Float64Array(2048);
    for(let i=0;i<4096;i++){powMantissa[i]=exactPow(1+i/4096,SRGB_POWER);powInverse[i]=1/(1+i/4096);}
    for(let e=0;e<2048;e++)powExponent[e]=exactPow(2,SRGB_POWER*(e-1023));
  }
  return [powMantissa,powInverse,powExponent,Float64Array.of(SRGB_POWER,POW_C2,POW_C3)];
}
export function srgbExact(p,indices,count) {
  const exact=transferCurve({transferFunction:'srgb'},false);
  for(let k=0;k<count;k++)p[indices[k]]=exact(p[indices[k]]);
}
export function srgbPlane(p) {
  srgbTables();
  const bits=new Uint32Array(p.buffer,p.byteOffset,p.length),f=Math.fround,exact=transferCurve({transferFunction:'srgb'},false);
  for(let i=0;i<p.length;i++) {
    const word=bits[i],x=p[i],exponent=word>>>23;
    if(exponent>=255){p[i]=exact(x);continue;}
    if(x<=0.0031308){p[i]=12.92*x;continue;}
    const index=word>>>11&4095,t=(1+(word&0x7fffff)/8388608-(1+index/4096))*powInverse[index];
    const r=1.055*(powMantissa[index]*powExponent[exponent+896]*(1+t*(SRGB_POWER+t*(POW_C2+t*POW_C3))))-0.055,d=1e-12*(1+r);
    p[i]=f(r-d)===f(r+d)?r:exact(x);
  }
  return p;
}

let srgb8;
const exactSrgb = transferCurve({transferFunction: "srgb"}, false);
const invSrgb = transferCurve({transferFunction: "srgb"}, true);
exactLog(1.5);
export function srgb8Table() {
  if (!srgb8) {
    const p = new Float32Array(1), word = new Uint32Array(p.buffer), thresholds = new Uint32Array(257).fill(0xffffffff, 256), steps = new Uint8Array(32768);
    const level = bits => { word[0] = bits; const x = p[0], r = x <= 0.0031308 ? 12.92 * x : exactSrgb(x), t = Math.fround(r) * 255 + .5; return t >= 255.5 ? 255 : t >= 1 ? t | 0 : 0; };
    for (let k = 1; k < 256; k++) {
      p[0] = invSrgb((k - 0.5) / 255);
      let low = Math.max(thresholds[k - 1], word[0] - 4);
      while (low > thresholds[k - 1] && level(low - 1) >= k) low--;
      while (low < 0x7f800000 && level(low) < k) low++;
      if (!(low < 0x7f800000)) throw new Error('Invalid sRGB8 threshold.');
      thresholds[k] = low;
    }
    for (let b = 0, k = 0; b <= 0x7f80; b++) { while (k < 255 && thresholds[k + 1] <= (b << 16)) k++; steps[b] = k; }
    for (let k = 2; k < 256; k++) if (thresholds[k] >>> 16 === thresholds[k - 1] >>> 16) throw new Error('Two sRGB8 thresholds share a step.');
    srgb8 = {thresholds, steps};
  }
  return srgb8;
}
export function srgb8Pixels(planes, n, out) {
  const {thresholds, steps} = srgb8Table(), [r, g, b] = planes.map(p => new Uint32Array(p.buffer, p.byteOffset, n));
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    out[o] = srgb8Level(r[i], thresholds, steps); out[o + 1] = srgb8Level(g[i], thresholds, steps); out[o + 2] = srgb8Level(b[i], thresholds, steps); out[o + 3] = 255;
  }
  return out;
}
export function srgb8Level(bits, thresholds, steps) {
  if (bits > 0x7f800000) return 0;
  const k = steps[bits >>> 16];
  return bits >= thresholds[k + 1] ? k + 1 : k;
}

export function hlgScale(intensityTarget,inverse=false) {
  const gamma=1.2*exactPow(1.111,exactLog(intensityTarget/1000)/Math.LN2);
  return inverse?1/gamma-1:gamma-1;
}
export function hlgOotf(v,luminance,exponent) {
  const y=luminance[0]*v[0]+luminance[1]*v[1]+luminance[2]*v[2];
  const scale=y>0?exactPow(y,exponent):0;
  v[0]*=scale;v[1]*=scale;v[2]*=scale;return v;
}

export function labXYZ(lab,out=lab) {
  const fy=(lab[0]+16)/116,fx=fy+lab[1]/500,fz=fy-lab[2]/200;
  const f=v=>v>6/29?v*v*v:3*(6/29)*(6/29)*(v-4/29);
  out[0]=D50[0]*f(fx);out[1]=f(fy);out[2]=D50[2]*f(fz);return out;
}
export function xyzLab(xyz,out=xyz) {
  const f=v=>v>216/24389?exactPow(v,1/3):v*841/108+4/29;
  const x=f(xyz[0]/D50[0]),y=f(xyz[1]),z=f(xyz[2]/D50[2]);
  out[0]=116*y-16;out[1]=500*(x-y);out[2]=200*(y-z);return out;
}
