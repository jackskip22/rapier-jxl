// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {exactCbrt} from './exact-math.mjs';
import {part} from './decode-parts.mjs';
import {decodeKernels} from './decode-kernels.mjs';
import {D50,SRGB_D50,D50_SRGB,IDENTITY3,adaptWhite,whiteXYZ,primariesXYZ,floatColorMatrix,inverse3,multiply3,vector3,transferCurve,srgbPlane,srgb8Pixels,hlgScale,hlgOotf} from './decode-color-math.mjs';

const SRGB={space:'rgb',wantICC:false,whitePoint:'d65',primaries:'srgb',transferFunction:'srgb',renderingIntent:1};
const LINEAR_SRGB={...SRGB,transferFunction:'linear'};
const XYB_SCALE=[22.995788804,1.183000077,1.502141333],XYB_OFFSET=[0.015386134,0,0.27770459];
const signature=bytes=>bytes?.length>=20?String.fromCharCode(bytes[16],bytes[17],bytes[18],bytes[19]):null;
export function nativeEncoding(h,icc=h.icc) {
  const encoding={...h.colorEncoding};
  if(encoding.wantICC&&icc){
    encoding.iccSpace=signature(icc);encoding.transferFunction='icc';
    if(icc.length>=68)encoding.renderingIntent=new DataView(icc.buffer,icc.byteOffset,icc.byteLength).getUint32(64);
    delete encoding.transferId;delete encoding.gamma;delete encoding.whitePoint;delete encoding.whitePointId;delete encoding.primaries;delete encoding.primariesId;
    if(encoding.iccSpace==='CMYK'){encoding.space='cmyk';encoding.invertedCMYK=true;}
  }
  return encoding;
}
export function targetEncoding(option) {
  if(option&&typeof option==='object') {
    requireDecode(!Array.isArray(option)&&['rgb','gray','xyb'].includes(option.space),'Invalid structured JPEG XL output color space.');
    requireDecode(!option.wantICC&&option.iccSpace==null,'A structured output encoding cannot supply an ICC profile.');
    const gamma=option.gamma!==undefined;
    requireDecode(!gamma||Number.isFinite(option.gamma)&&option.gamma>0,'Invalid JPEG XL output gamma.');
    requireDecode(!gamma||option.transferFunction===undefined||option.transferFunction==='gamma','JPEG XL output gamma conflicts with its transfer function.');
    requireDecode(option.transferFunction!=='gamma'||gamma,'JPEG XL gamma output needs an exponent.');
    requireDecode(option.renderingIntent===undefined||Number.isInteger(option.renderingIntent)&&option.renderingIntent>=0&&option.renderingIntent<=3,'Invalid JPEG XL output rendering intent.');
    if(option.space==='xyb') {
      requireDecode((!gamma||option.gamma===1/3)&&(option.transferFunction===undefined||option.transferFunction==='gamma'),'XYB output has an implicit transfer function.');
      return {wantICC:false,whitePoint:'d65',renderingIntent:0,...option,transferFunction:'gamma',gamma:1/3};
    }
    return {wantICC:false,whitePoint:'d65',primaries:'srgb',renderingIntent:1,...option,transferFunction:option.transferFunction??(gamma?'gamma':'srgb')};
  }
  if(option==='srgb')return {...SRGB};
  if(option==='linear-srgb')return {...LINEAR_SRGB};
  if(option==='display-p3'||option==='rec2020')return {...SRGB,primaries:option};
  if(option==='xyb')return {space:'xyb',wantICC:false,whitePoint:'d65',transferFunction:'gamma',gamma:1/3,renderingIntent:0};
  requireDecode(false,'Unknown JPEG XL output color space.');
}
function finish(frame,planes,encoding,icc=undefined,extraChannels=frame.extraChannels) {
  return {...frame,planes,widths:planes.map(()=>frame.width),heights:planes.map(()=>frame.height),extraChannels,colorEncoding:encoding,icc,ctDone:true};
}
function xybConstants(h,transform) {
  const f=Math.fround,{inverseMatrix,opsinBiases}=h.opsinInverseMatrix,bias=opsinBiases.map(f),raw=transform===IDENTITY3?inverseMatrix.map(f):multiply3(transform,inverseMatrix.map(f)).map(f),root=bias.map(v=>f(exactCbrt(v))),scale=f(255/h.toneMapping.intensityTarget),m=raw.map(v=>f(v*scale));
  return {bias,root,m};
}
function xybInverse(h,transform=IDENTITY3) {
  const f=Math.fround,{bias,root,m}=xybConstants(h,transform);
  return (v,out=v)=>{
    const l=f(f(v[1]+v[0])-root[0]),m0=f(f(v[1]-v[0])-root[1]),s=f(v[2]-root[2]);
    const a=f(f(l*l)*l+bias[0]),b=f(f(m0*m0)*m0+bias[1]),c=f(f(s*s)*s+bias[2]);
    out[0]=f(m[2]*c+f(m[1]*b+f(m[0]*a)));out[1]=f(m[5]*c+f(m[4]*b+f(m[3]*a)));out[2]=f(m[8]*c+f(m[7]*b+f(m[6]*a)));return out;
  };
}
function xybToEnum(frame,h,encoding,inPlace=false,rgba8=null) {
  const gray=encoding.space==='gray',n=frame.width*frame.height,native=primariesXYZ(gray?'srgb':encoding.primaries,encoding.whitePoint);
  let transform=IDENTITY3;
  if(gray) {
    const y=encoding.whitePoint==='d65'?[0.2126,0.7152,0.0722]:multiply3(adaptWhite(whiteXYZ(),whiteXYZ(encoding.whitePoint)),primariesXYZ()).slice(3,6);
    transform=[...y,...y,...y];
  } else if(encoding.primaries!=='srgb'||encoding.whitePoint!=='d65')transform=multiply3(inverse3(floatColorMatrix(encoding.primaries,encoding.whitePoint).pcs).map(Math.fround),floatColorMatrix().pcs).map(Math.fround);
  const inverse=xybInverse(h,transform),curve=transferCurve(encoding,false,h.toneMapping.intensityTarget),gamma=encoding.transferFunction==='gamma'||encoding.transferFunction==='dci';
  const exponent=encoding.transferFunction==='hlg'?hlgScale(h.toneMapping.intensityTarget,true):0,luminance=native.slice(3,6),v=new Float64Array(3);
  const fast=!gray&&(encoding.transferFunction??(encoding.gamma===undefined?'srgb':'gamma'))==='srgb',planes=fast&&inPlace?frame.planes:Array.from({length:gray?1:3},()=>new Float32Array(n));
  const kernels=decodeKernels();
  if(fast&&inPlace&&kernels&&planes.every(p=>p.buffer===kernels.buffer)) {
    if(rgba8&&rgba8.buffer===kernels.buffer){kernels.xyb(n,planes[0],planes[1],planes[2],xybConstants(h,transform),rgba8);return {...finish(frame,planes,encoding),rgba8};}
    kernels.xyb(n,planes[0],planes[1],planes[2],xybConstants(h,transform));
    if(rgba8)return {...finish(frame,planes,encoding),rgba8:srgb8Pixels(planes,n,rgba8)};
    for(const p of planes)kernels.srgb(p.subarray(0,n),kernels.list);
    return finish(frame,planes,encoding);
  }
  if(fast) {
    const f=Math.fround,{bias,root,m}=xybConstants(h,transform),[x0,y0,b0]=frame.planes,[r,g,b]=planes;
    const r0=root[0],r1=root[1],r2=root[2],s0=bias[0],s1=bias[1],s2=bias[2],[m0,m1,m2,m3,m4,m5,m6,m7,m8]=m;
    for(let i=0;i<n;i++) {
      const x=x0[i],y=y0[i],l=f(f(y+x)-r0),q=f(f(y-x)-r1),s=f(b0[i]-r2);
      const a=f(f(l*l)*l+s0),d=f(f(q*q)*q+s1),c=f(f(s*s)*s+s2);
      r[i]=m2*c+f(m1*d+f(m0*a));g[i]=m5*c+f(m4*d+f(m3*a));b[i]=m8*c+f(m7*d+f(m6*a));
    }
    if(rgba8)return {...finish(frame,planes,encoding),rgba8:srgb8Pixels(planes,n,rgba8)};
    srgbPlane(r);srgbPlane(g);srgbPlane(b);
    return finish(frame,planes,encoding);
  }
  for(let i=0;i<n;i++) {
    v[0]=frame.planes[0][i];v[1]=frame.planes[1][i];v[2]=frame.planes[2][i];inverse(v);
    if(exponent)hlgOotf(v,luminance,exponent);
    for(let c=0;c<planes.length;c++)planes[c][i]=gamma&&v[c]<=1e-5?0:curve(v[c]);
  }
  return finish(frame,planes,encoding);
}
function xybForward(h) {
  const m=inverse3(h.opsinInverseMatrix.inverseMatrix),bias=h.opsinInverseMatrix.opsinBiases,root=bias.map(exactCbrt),scale=h.toneMapping.intensityTarget/255;
  return (v,out=v)=>{
    const a=exactCbrt((m[0]*v[0]+m[1]*v[1]+m[2]*v[2])*scale-bias[0])+root[0];
    const b=exactCbrt((m[3]*v[0]+m[4]*v[1]+m[5]*v[2])*scale-bias[1])+root[1];
    const c=exactCbrt((m[6]*v[0]+m[7]*v[1]+m[8]*v[2])*scale-bias[2])+root[2];
    const x=(a-b)/2,y=(a+b)/2;out[0]=(x+XYB_OFFSET[0])*XYB_SCALE[0];out[1]=y*XYB_SCALE[1];out[2]=(c-y+XYB_OFFSET[2])*XYB_SCALE[2];return out;
  };
}
function enumToPCS(encoding,h) {
  if(encoding.space==='xyb') {
    const inverse=xybInverse(h);
    return (v,out)=>{const x=v[0]/XYB_SCALE[0]-XYB_OFFSET[0],y=v[1]/XYB_SCALE[1],b=v[2]/XYB_SCALE[2]-XYB_OFFSET[2]+y;out[0]=x;out[1]=y;out[2]=b;inverse(out);return vector3(SRGB_D50,out);};
  }
  requireDecode(encoding.space==='rgb'||encoding.space==='gray','Cannot convert unspecified native JPEG XL channels.');
  const gray=encoding.space==='gray',white=whiteXYZ(encoding.whitePoint),native=primariesXYZ(gray?'srgb':encoding.primaries,encoding.whitePoint),matrix=multiply3(adaptWhite(white,D50),native);
  const curve=transferCurve(encoding,true,h.toneMapping.intensityTarget),ootf=encoding.transferFunction==='hlg'?hlgScale(h.toneMapping.intensityTarget):0,luminance=native.slice(3,6);
  return (v,out)=>{out[0]=curve(v[0]);out[1]=gray?out[0]:curve(v[1]);out[2]=gray?out[0]:curve(v[2]);if(ootf)hlgOotf(out,luminance,ootf);return vector3(matrix,out);};
}
function enumFromPCS(encoding,h) {
  if(encoding.space==='xyb') {const forward=xybForward(h);return (v,out)=>forward(vector3(D50_SRGB,v,out));}
  requireDecode(encoding.space==='rgb'||encoding.space==='gray','Cannot convert to unspecified JPEG XL channels.');
  const gray=encoding.space==='gray',white=whiteXYZ(encoding.whitePoint),native=primariesXYZ(gray?'srgb':encoding.primaries,encoding.whitePoint),adapt=adaptWhite(D50,white),matrix=gray?adapt:multiply3(inverse3(native),adapt);
  const curve=transferCurve(encoding,false,h.toneMapping.intensityTarget),ootf=encoding.transferFunction==='hlg'?hlgScale(h.toneMapping.intensityTarget,true):0,luminance=native.slice(3,6);
  return (v,out)=>{vector3(matrix,v,out);if(gray){const y=out[1];out[0]=y;out[1]=y;out[2]=y;}if(ootf)hlgOotf(out,luminance,ootf);out[0]=curve(out[0]);if(!gray){out[1]=curve(out[1]);out[2]=curve(out[2]);}return out;};
}
export function sameEncoding(a,b) {
  return !a.wantICC&&!b.wantICC&&a.space===b.space&&a.transferFunction===b.transferFunction&&a.gamma===b.gamma&&JSON.stringify(a.whitePoint??'d65')===JSON.stringify(b.whitePoint??'d65')&&(a.space==='gray'||JSON.stringify(a.primaries??'srgb')===JSON.stringify(b.primaries??'srgb'));
}

const STEPS=65536,LOW=-STEPS/4,SIZE=STEPS*3/2,kept=[];
function curveTable(read,key) {
  const at=kept.findIndex(t=>t.key===key);
  if(at>=0){const [table]=kept.splice(at,1);kept.push(table);return table;}
  const values=new Float32Array(SIZE*2);
  for(let i=0,next=read(LOW/STEPS);i<SIZE;i++) {
    const value=next;next=read((i+1+LOW)/STEPS);
    values[i*2]=value;values[i*2+1]=Math.abs((value+next)/2-read((i+LOW+.5)/STEPS))<=1e-7?next-value:NaN;
  }
  let error=0;
  for(let i=0;i<SIZE;i++)if(values[i*2+1]===values[i*2+1])for(const s of [0,.25,.5,.75])error=Math.max(error,Math.abs(values[i*2]+values[i*2+1]*s-read((i+LOW+s)/STEPS)));
  const table={key,values,error:2*error};
  kept.push(table);if(kept.length>2)kept.shift();
  return table;
}
function enumModel(encoding,h,toLinear) {
  const tf=encoding.transferFunction??(encoding.gamma===undefined?'srgb':'gamma');
  if(encoding.wantICC||encoding.space!=='rgb'||tf==='hlg'||tf==='unknown')return null;
  const key=JSON.stringify([tf,encoding.gamma,toLinear,h.toneMapping.intensityTarget]),curve=transferCurve(encoding,toLinear,h.toneMapping.intensityTarget);
  const white=whiteXYZ(encoding.whitePoint),native=primariesXYZ(encoding.primaries,encoding.whitePoint);
  return {matrix:toLinear?multiply3(adaptWhite(white,D50),native):multiply3(inverse3(native),adaptWhite(D50,white)),curves:[curve,curve,curve],keys:[key,key,key]};
}
function tableCurve(values,read,x) {
  const p=x*STEPS-LOW;
  if(!(p>=0&&p<SIZE))return read(x);
  const i=p|0,slope=values[i*2+1];
  return slope===slope?values[i*2]+slope*(p-i):read(x);
}
function certain(values,maximum,linear,out,error,a) {
  const p=linear*STEPS-LOW;
  if(!(p>=0&&p<SIZE))return -1;
  const i=p|0,slope=values[i*2+1];
  if(slope!==slope)return -1;
  const near=Math.max(Math.abs(slope),i?Math.abs(values[i*2-1]):0,i+1<SIZE?Math.abs(values[i*2+3]):0)*STEPS,y=(values[i*2]+slope*(p-i))*a;
  const spread=((out+2*near*error+1e-12)*a+Math.abs(y)*2.4e-7)*maximum,t=y*maximum+.5;
  if(!(spread<Infinity&&t<Infinity&&t>-Infinity))return -1;
  return quantized(t-spread,maximum)===quantized(t+spread,maximum)?Math.fround(y):-1;
}
function quantized(t,maximum) { return t>=maximum+.5?maximum:t>=1?Math.floor(t):0; }
function quantizedConvert(frame,n,from,to,alpha,planes,maximum,exact) {
  const [f0,f1,f2]=from.curves,inTables=from.curves.map((c,i)=>curveTable(c,from.keys[i])),outTables=to.curves.map((c,i)=>curveTable(c,to.keys[i]));
  const [i0,i1,i2]=inTables.map(t=>t.values),[o0,o1,o2]=outTables.map(t=>t.values),[q0,q1,q2]=outTables.map(t=>t.error),m=multiply3(to.matrix,from.matrix),[m0,m1,m2,m3,m4,m5,m6,m7,m8]=m;
  const input=Math.max(...inTables.map(t=>t.error)),[e0,e1,e2]=[0,3,6].map(r=>(Math.abs(m[r])+Math.abs(m[r+1])+Math.abs(m[r+2]))*input+1e-12);
  const [p0,p1,p2]=frame.planes,[r,g,b]=planes;
  for(let i=0;i<n;i++) {
    const a=alpha?alpha[i]:1;
    if(!(a>0))continue;
    const x=tableCurve(i0,f0,p0[i]/a),y=tableCurve(i1,f1,p1[i]/a),z=tableCurve(i2,f2,p2[i]/a);
    const u=certain(o0,maximum,m0*x+m1*y+m2*z,q0,e0,a),v=u<0?-1:certain(o1,maximum,m3*x+m4*y+m5*z,q1,e1,a),w=v<0?-1:certain(o2,maximum,m6*x+m7*y+m8*z,q2,e2,a);
    if(w<0)exact(i);else{r[i]=u;g[i]=v;b[i]=w;}
  }
}

function convert(frame,h,source,target,sourceICC,targetICC,preserveAssociation=false,quantize=0) {
  if(sameEncoding(source,target)||sourceICC&&sourceICC===targetICC)return finish(frame,frame.planes,target,targetICC);
  const intent=target.renderingIntent??source.renderingIntent;
  const inputProfile=sourceICC?part('iccColor').readICCColor(sourceICC,{intent}):null,outputProfile=targetICC?part('iccColor').readICCColor(targetICC,{intent}):null;
  const toPCS=inputProfile?.toPCS??(!sourceICC?enumToPCS(source,h):null),fromPCS=outputProfile?.fromPCS??(!targetICC?enumFromPCS(target,h):null);
  requireDecode(toPCS&&fromPCS,'ICC profile does not provide the requested color transform.');
  const n=frame.width*frame.height,inputCount=inputProfile?.channels??(source.space==='gray'?1:3),outputCount=outputProfile?.channels??(target.space==='gray'?1:3);
  const black=frame.extraChannels?.findIndex(c=>c.type===4)??-1;
  requireDecode(inputCount!==4||black>=0,'CMYK JPEG XL image is missing its black channel.');
  const planes=Array.from({length:Math.min(3,outputCount)},()=>new Float32Array(n)),k=outputCount===4?new Float32Array(n):null;
  const input=new Float64Array(16),xyz=new Float64Array(3),out=new Float64Array(16),sourceBlack=black>=0?frame.extraChannels[black].data:null;
  const inputInk=inputCount===4&&source.invertedCMYK!==false,outputInk=outputCount===4&&target.invertedCMYK!==false;
  const firstAlpha=preserveAssociation?frame.extraChannels?.find(c=>c.type===0):null,alpha=firstAlpha?.associated?firstAlpha.data:null;
  const inputXYB=!sourceICC&&source.space==='xyb',outputXYB=!targetICC&&target.space==='xyb';
  const pixel=i=>{
    const a=alpha?alpha[i]:1;
    if(alpha&&!(a>0))return;
    for(let c=0;c<inputCount;c++) {
      const stored=c===3?sourceBlack[i]:frame.planes[c][i],value=alpha&&!inputXYB?stored/a:stored;
      input[c]=inputInk?1-value:value;
    }
    toPCS(input,xyz);
    if(alpha&&inputXYB)for(let c=0;c<3;c++)xyz[c]/=a;
    if(alpha&&outputXYB)for(let c=0;c<3;c++)xyz[c]*=a;
    fromPCS(xyz,out);
    const scale=alpha&&!outputXYB?a:1;
    for(let c=0;c<planes.length;c++)planes[c][i]=(outputInk?1-out[c]:out[c])*scale;
    if(k)k[i]=(outputInk?1-out[3]:out[3])*scale;
  };
  const from=quantize&&inputCount===3&&n>=STEPS&&(sourceICC?inputProfile.toModel:enumModel(source,h,true)),to=from&&outputCount===3&&(targetICC?outputProfile.fromModel:enumModel(target,h,false));
  if(to)quantizedConvert(frame,n,from,to,alpha,planes,quantize,pixel);
  else for(let i=0;i<n;i++)pixel(i);
  let extras=frame.extraChannels;
  if(k){requireDecode(black>=0,'CMYK output needs a black extra channel.');extras=extras.map((c,i)=>i===black?{...c,data:k}:c);}
  return finish(frame,planes,target,targetICC,extras);
}

export function convertOutputColor(frame,h,{colorSpace='original',icc,quantize=0}={}) {
  const source=frame.colorEncoding??nativeEncoding(h),sourceICC=frame.icc??(source.wantICC?h.icc:undefined);
  if(colorSpace==='original'&&!icc)return finish(frame,frame.planes,source,sourceICC);
  const target=icc?{space:signature(icc)==='GRAY'?'gray':signature(icc)==='CMYK'?'cmyk':'rgb',wantICC:true,transferFunction:'icc',iccSpace:signature(icc),invertedCMYK:signature(icc)==='CMYK',renderingIntent:icc.length>=68?new DataView(icc.buffer,icc.byteOffset,icc.byteLength).getUint32(64):undefined}:targetEncoding(colorSpace);
  return convert(frame,h,source,target,sourceICC,icc,true,quantize);
}

export function transformColor(frame,h,f,{colorSpace='original',icc,inPlace=false,rgba8=null}={}) {
  if(frame.ctDone||frame.colorEncoding)return convertOutputColor(frame,h,{colorSpace,icc});
  const original=nativeEncoding(h),n=frame.width*frame.height;
  requireDecode(frame.planes.every(p=>p.length===n),'JPEG XL color planes have different extents.');
  let decoded;
  if(f.ycbcr) {
    requireDecode(frame.planes.length===3,'JPEG XL YCbCr needs three planes.');
    const planes=Array.from({length:original.space==='gray'?1:3},()=>new Float32Array(n));
    for(let i=0;i<n;i++){const cb=frame.planes[0][i],y=frame.planes[1][i]+128/255,cr=frame.planes[2][i];planes[0][i]=y+1.402*cr;if(planes.length===3){planes[1][i]=y-0.114*1.772/0.587*cb-0.299*1.402/0.587*cr;planes[2][i]=y+1.772*cb;}}
    decoded=finish(frame,planes,original,h.icc);
  } else if(!h.xyb)decoded=finish(frame,frame.planes,original,h.icc);
  else if(original.space==='xyb') {
    const planes=Array.from({length:3},()=>new Float32Array(n));
    for(let i=0;i<n;i++){const x=frame.planes[0][i],y=frame.planes[1][i],b=frame.planes[2][i];planes[0][i]=(x+XYB_OFFSET[0])*XYB_SCALE[0];planes[1][i]=y*XYB_SCALE[1];planes[2][i]=(b-y+XYB_OFFSET[2])*XYB_SCALE[2];}
    decoded=finish(frame,planes,original,h.icc);
  } else {
    requireDecode(frame.planes.length===3,'JPEG XL XYB needs three planes.');
    if(!original.wantICC&&(original.space==='rgb'||original.space==='gray')&&original.transferFunction!=='unknown') {
      if(colorSpace==='original'&&!icc)return xybToEnum(frame,h,original,inPlace,rgba8);
      return convertOutputColor(xybToEnum(frame,h,original,inPlace),h,{colorSpace,icc});
    }
    const planes=Array.from({length:3},()=>new Float32Array(n)),inverse=xybInverse(h),pixel=new Float64Array(3);
    for(let i=0;i<n;i++){pixel[0]=frame.planes[0][i];pixel[1]=frame.planes[1][i];pixel[2]=frame.planes[2][i];inverse(pixel);for(let c=0;c<3;c++)planes[c][i]=pixel[c];}
    decoded=finish(frame,planes,{...LINEAR_SRGB});
    let canOriginal=original.space==='rgb'||original.space==='gray';
    if(original.wantICC){const {readICCColor}=part('iccColor');try{canOriginal=!!readICCColor(h.icc).fromPCS;}catch{canOriginal=false;}}
    else if(original.transferFunction==='unknown')canOriginal=false;
    if(canOriginal)decoded=convert(decoded,h,decoded.colorEncoding,original,undefined,h.icc);
  }
  return colorSpace==='original'&&!icc?decoded:convertOutputColor(decoded,h,{colorSpace,icc});
}
