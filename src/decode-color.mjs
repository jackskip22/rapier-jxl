// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {exactCbrt} from './exact-math.mjs';
import {part} from './decode-parts.mjs';
import {decodeKernels} from './decode-kernels.mjs';
import {D50,SRGB_D50,D50_SRGB,IDENTITY3,adaptWhite,whiteXYZ,primariesXYZ,floatColorMatrix,inverse3,multiply3,transferCurve,hlgScale} from './decode-color-math.mjs';
import {OP,convertPixels,throughKernels,curveTable} from './decode-color-program.mjs';

const SRGB={space:'rgb',wantICC:false,whitePoint:'d65',primaries:'srgb',transferFunction:'srgb',renderingIntent:1};
const LINEAR_SRGB={...SRGB,transferFunction:'linear'};
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
  const {bias,root,m}=xybConstants(h,transform);
  return {op:OP.xybInverse,data:Float64Array.of(...bias,...root,...m)};
}
const curveOp=(c,curve,gammaZero=false)=>({op:OP.curve,a:c,b:gammaZero?1:0,curve});
function xybToEnum(frame,h,encoding,inPlace=false,rgba8=null) {
  const gray=encoding.space==='gray',n=frame.width*frame.height,native=primariesXYZ(gray?'srgb':encoding.primaries,encoding.whitePoint);
  let transform=IDENTITY3;
  if(gray) {
    const y=encoding.whitePoint==='d65'?[0.2126,0.7152,0.0722]:multiply3(adaptWhite(whiteXYZ(),whiteXYZ(encoding.whitePoint)),primariesXYZ()).slice(3,6);
    transform=[...y,...y,...y];
  } else if(encoding.primaries!=='srgb'||encoding.whitePoint!=='d65')transform=multiply3(inverse3(floatColorMatrix(encoding.primaries,encoding.whitePoint).pcs).map(Math.fround),floatColorMatrix().pcs).map(Math.fround);
  const fast=!gray&&(encoding.transferFunction??(encoding.gamma===undefined?'srgb':'gamma'))==='srgb',kernels=decodeKernels();
  if(fast) {
    const constants=xybConstants(h,transform);
    if(inPlace&&frame.planes.every(p=>p.buffer===kernels.buffer)) {
      const planes=frame.planes;
      if(rgba8){requireDecode(rgba8.buffer===kernels.buffer,'RGBA8 rows are outside the kernels.');kernels.xyb(n,planes[0],planes[1],planes[2],constants,rgba8);return {...finish(frame,planes,encoding),rgba8};}
      kernels.xyb(n,planes[0],planes[1],planes[2],constants);
      for(const p of planes)kernels.srgb(p.subarray(0,n));
      return finish(frame,planes,encoding);
    }
    const planes=[0,1,2].map(()=>new Float32Array(n));
    throughKernels(n,frame.planes.slice(0,3),planes,(count,[x,y,b])=>{kernels.xyb(count,x,y,b,constants);kernels.srgb(x);kernels.srgb(y);kernels.srgb(b);});
    return finish(frame,planes,encoding);
  }
  const curve=transferCurve(encoding,false,h.toneMapping.intensityTarget),gamma=encoding.transferFunction==='gamma'||encoding.transferFunction==='dci';
  const exponent=encoding.transferFunction==='hlg'?hlgScale(h.toneMapping.intensityTarget,true):0,luminance=native.slice(3,6);
  const planes=Array.from({length:gray?1:3},()=>new Float32Array(n));
  const to=[xybInverse(h,transform),...(exponent?[{op:OP.hlgOotf,data:Float64Array.of(...luminance,exponent)}]:[]),...planes.map((_,c)=>curveOp(c,curve,gamma))];
  convertPixels(n,{inputs:frame.planes.slice(0,3),outputs:planes,to});
  return finish(frame,planes,encoding);
}
function xybForward(h) {
  const m=inverse3(h.opsinInverseMatrix.inverseMatrix),bias=h.opsinInverseMatrix.opsinBiases,root=bias.map(exactCbrt),scale=h.toneMapping.intensityTarget/255;
  return {op:OP.xybForward,data:Float64Array.of(...m,...bias,...root,scale)};
}
function enumToPCS(encoding,h) {
  if(encoding.space==='xyb')return [{op:OP.xybUnscale},xybInverse(h),{op:OP.vector3,data:Float64Array.from(SRGB_D50)}];
  requireDecode(encoding.space==='rgb'||encoding.space==='gray','Cannot convert unspecified native JPEG XL channels.');
  const gray=encoding.space==='gray',white=whiteXYZ(encoding.whitePoint),native=primariesXYZ(gray?'srgb':encoding.primaries,encoding.whitePoint),matrix=multiply3(adaptWhite(white,D50),native);
  const curve=transferCurve(encoding,true,h.toneMapping.intensityTarget),ootf=encoding.transferFunction==='hlg'?hlgScale(h.toneMapping.intensityTarget):0,luminance=native.slice(3,6);
  return [curveOp(0,curve),...(gray?[{op:OP.grayAll}]:[curveOp(1,curve),curveOp(2,curve)]),...(ootf?[{op:OP.hlgOotf,data:Float64Array.of(...luminance,ootf)}]:[]),{op:OP.vector3,data:Float64Array.from(matrix)}];
}
function enumFromPCS(encoding,h) {
  if(encoding.space==='xyb')return [{op:OP.vector3,data:Float64Array.from(D50_SRGB)},xybForward(h)];
  requireDecode(encoding.space==='rgb'||encoding.space==='gray','Cannot convert to unspecified JPEG XL channels.');
  const gray=encoding.space==='gray',white=whiteXYZ(encoding.whitePoint),native=primariesXYZ(gray?'srgb':encoding.primaries,encoding.whitePoint),adapt=adaptWhite(D50,white),matrix=gray?adapt:multiply3(inverse3(native),adapt);
  const curve=transferCurve(encoding,false,h.toneMapping.intensityTarget),ootf=encoding.transferFunction==='hlg'?hlgScale(h.toneMapping.intensityTarget,true):0,luminance=native.slice(3,6);
  return [{op:OP.vector3,data:Float64Array.from(matrix)},...(gray?[{op:OP.grayFromY}]:[]),...(ootf?[{op:OP.hlgOotf,data:Float64Array.of(...luminance,ootf)}]:[]),
    curveOp(0,curve),...(gray?[]:[curveOp(1,curve),curveOp(2,curve)])];
}
export function sameEncoding(a,b) {
  return !a.wantICC&&!b.wantICC&&a.space===b.space&&a.transferFunction===b.transferFunction&&a.gamma===b.gamma&&JSON.stringify(a.whitePoint??'d65')===JSON.stringify(b.whitePoint??'d65')&&(a.space==='gray'||JSON.stringify(a.primaries??'srgb')===JSON.stringify(b.primaries??'srgb'));
}

const STEPS=65536,kept=[];
function keptTable(curve,key) {
  const at=kept.findIndex(t=>t.key===key);
  if(at>=0){const [table]=kept.splice(at,1);kept.push(table);return table;}
  const table={key,...curveTable(curve)};
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
function quantizedJob(from,to,maximum) {
  const inTables=from.curves.map((c,i)=>keptTable(c,from.keys[i])),outTables=to.curves.map((c,i)=>keptTable(c,to.keys[i])),m=multiply3(to.matrix,from.matrix);
  const input=Math.max(...inTables.map(t=>t.error));
  return {tables:[...inTables,...outTables].map(t=>t.values),curves:from.curves,errors:outTables.map(t=>t.error),
    bounds:[0,3,6].map(r=>(Math.abs(m[r])+Math.abs(m[r+1])+Math.abs(m[r+2]))*input+1e-12),matrix:m,maximum};
}

function convert(frame,h,source,target,sourceICC,targetICC,preserveAssociation=false,quantize=0) {
  if(sameEncoding(source,target)||sourceICC&&sourceICC===targetICC)return finish(frame,frame.planes,target,targetICC);
  const intent=target.renderingIntent??source.renderingIntent;
  const inputProfile=sourceICC?part('iccColor').readICCColor(sourceICC,{intent}):null,outputProfile=targetICC?part('iccColor').readICCColor(targetICC,{intent}):null;
  const toPCS=inputProfile?inputProfile.toPCS?.ops:!sourceICC?enumToPCS(source,h):null,fromPCS=outputProfile?outputProfile.fromPCS?.ops:!targetICC?enumFromPCS(target,h):null;
  requireDecode(toPCS&&fromPCS,'ICC profile does not provide the requested color transform.');
  const n=frame.width*frame.height,inputCount=inputProfile?.channels??(source.space==='gray'?1:3),outputCount=outputProfile?.channels??(target.space==='gray'?1:3);
  const black=frame.extraChannels?.findIndex(c=>c.type===4)??-1;
  requireDecode(inputCount!==4||black>=0,'CMYK JPEG XL image is missing its black channel.');
  const planes=Array.from({length:Math.min(3,outputCount)},()=>new Float32Array(n)),k=outputCount===4?new Float32Array(n):null;
  const inputInk=inputCount===4&&source.invertedCMYK!==false,outputInk=outputCount===4&&target.invertedCMYK!==false;
  const firstAlpha=preserveAssociation?frame.extraChannels?.find(c=>c.type===0):null,alpha=firstAlpha?.associated?firstAlpha.data:null;
  const inputXYB=!sourceICC&&source.space==='xyb',outputXYB=!targetICC&&target.space==='xyb';
  const from=quantize&&inputCount===3&&n>=STEPS&&(sourceICC?inputProfile.toModel:enumModel(source,h,true)),to=from&&outputCount===3&&(targetICC?outputProfile.fromModel:enumModel(target,h,false));
  convertPixels(n,{inputs:frame.planes.slice(0,Math.min(3,inputCount)),black:inputCount===4?frame.extraChannels[black].data:null,alpha,outputs:planes,blackOut:k,
    flags:(inputInk?1:0)|(outputInk?2:0)|(inputXYB?4:0)|(outputXYB?8:0),to:toPCS,from:fromPCS,quantized:to?quantizedJob(from,to,quantize):null});
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
  const kernels=decodeKernels(),here=inPlace&&frame.planes.every(p=>p.buffer===kernels.buffer);
  const pixels=(count,ops)=>{const planes=here?frame.planes.slice(0,count):Array.from({length:count},()=>new Float32Array(n));convertPixels(n,{inputs:frame.planes.slice(0,3),outputs:planes,to:ops});return planes;};
  let decoded;
  if(f.ycbcr) {
    requireDecode(frame.planes.length===3,'JPEG XL YCbCr needs three planes.');
    const count=original.space==='gray'?1:3;
    decoded=finish(frame,pixels(count,[{op:OP.ycbcr,a:count}]),original,h.icc);
  } else if(!h.xyb)decoded=finish(frame,frame.planes,original,h.icc);
  else if(original.space==='xyb')decoded=finish(frame,pixels(3,[{op:OP.xybNative}]),original,h.icc);
  else {
    requireDecode(frame.planes.length===3,'JPEG XL XYB needs three planes.');
    if(!original.wantICC&&(original.space==='rgb'||original.space==='gray')&&original.transferFunction!=='unknown') {
      if(colorSpace==='original'&&!icc)return xybToEnum(frame,h,original,inPlace,rgba8);
      return convertOutputColor(xybToEnum(frame,h,original,inPlace),h,{colorSpace,icc});
    }
    const planes=pixels(3,[xybInverse(h)]);
    decoded=finish(frame,planes,{...LINEAR_SRGB});
    let canOriginal=original.space==='rgb'||original.space==='gray';
    if(original.wantICC){const {readICCColor}=part('iccColor');try{canOriginal=!!readICCColor(h.icc).fromPCS;}catch{canOriginal=false;}}
    else if(original.transferFunction==='unknown')canOriginal=false;
    if(canOriginal)decoded=convert(decoded,h,decoded.colorEncoding,original,undefined,h.icc);
  }
  return colorSpace==='original'&&!icc?decoded:convertOutputColor(decoded,h,{colorSpace,icc});
}
