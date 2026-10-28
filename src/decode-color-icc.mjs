// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {exactPow,exactLog} from './exact-math.mjs';
import {D50,inverse3,vector3,labXYZ,xyzLab} from './decode-color-math.mjs';

const clamp=x=>Math.max(0,Math.min(1,x));
const align4=n=>Math.ceil(n/4)*4;
const text=(b,at)=>String.fromCharCode(b[at],b[at+1],b[at+2],b[at+3]);
const XYZ_SCALE=65535/32768,LAB_OLD=65535/65280;
const cache=new WeakMap();
const DEFAULT_ICC_SAMPLES=16777216,DEFAULT_ICC_STAGES=256;

function profileBudget(maxSamples,maxStages) {
  let samples=0,stages=0;const numeric=new Map();
  const limit=message=>{throw Object.assign(new RangeError(message),{code:'JXL_LIMIT'});};
  const allocate=count=>{if(count>maxSamples-samples)limit('ICC parsed samples exceed the limit.');samples+=count;};
  return {
    allocate,
    stages(count=1){if(count>maxStages-stages)limit('ICC processing stages exceed the limit.');stages+=count;},
    numbers(view,at,count,kind) {
      const key=kind+':'+at+':'+count;let values=numeric.get(key);if(values)return values;
      allocate(count);
      values=Float64Array.from({length:count},(_,i)=>{
        if(kind==='u8')return view.getUint8(at+i)/255;
        if(kind==='u16')return view.getUint16(at+i*2)/65535;
        if(kind==='fixed')return view.getInt32(at+i*4)/65536;
        const value=view.getFloat32(at+i*4);requireDecode(Number.isFinite(value),'Nonfinite ICC transform parameter.');return value;
      });
      numeric.set(key,values);return values;
    },
  };
}

function sampledCurve(table) {
  const last=table.length-1;
  const read=x=>{const p=clamp(x)*last,i=Math.min(last-1,Math.floor(p));return table[i]+(table[i+1]-table[i])*(p-i);};
  const monotone=table.every((v,i)=>!i||v>=table[i-1]);
  const inverse=monotone?y=>{
    if(y<=table[0])return 0;if(y>=table[last])return 1;
    let lo=0,hi=last;while(hi-lo>1){const mid=(lo+hi)>>1;if(table[mid]<y)lo=mid;else hi=mid;}
    return (lo+(y-table[lo])/(table[hi]-table[lo]))/last;
  }:null;
  return {read,inverse};
}
function curve(view,at,end,budget) {
  budget.stages();
  const has=n=>requireDecode(at+n<=end,'Truncated ICC tone curve.');has(12);
  const tag=view.getUint32(at);
  if(tag===0x63757276) {
    const n=view.getUint32(at+8);has(12+n*2);
    if(!n)return {read:x=>x,inverse:x=>x,bytes:12,formula:'identity'};
    if(n===1){const g=view.getUint16(at+12)/256;requireDecode(g>0,'Invalid ICC curve gamma.');return {read:g===1?x=>x:x=>exactPow(Math.max(0,x),g),inverse:g===1?x=>x:x=>exactPow(Math.max(0,x),1/g),bytes:14,formula:'gamma '+g};}
    const table=budget.numbers(view,at+12,n,'u16');
    return {...sampledCurve(table),bytes:12+n*2};
  }
  requireDecode(tag===0x70617261,'Unsupported ICC tone curve type.');
  const form=view.getUint16(at+8),count=[1,3,4,5,7][form];
  requireDecode(count!==undefined,'Invalid ICC parametric curve.');has(12+4*count);
  const p=budget.numbers(view,at+12,count,'fixed');
  const [g,a=1,b=0,c=0,d=0,e=0,f=0]=p;requireDecode(g>0,'Invalid ICC curve exponent.');
  let read,inverse;
  if(form===0){read=g===1?x=>x:x=>exactPow(Math.max(0,x),g);inverse=g===1?x=>x:y=>exactPow(Math.max(0,y),1/g);}
  else {
    requireDecode(a!==0,'Invalid ICC curve scale.');
    const cut=form<=2?-b/a:d,add=form===2?c:form===4?e:0,low=form>=3?c:0,base=form===2?c:form===4?f:0;
    read=x=>x>=cut?exactPow(Math.max(0,a*x+b),g)+add:low*x+base;
    const boundary=read(cut);
    inverse=a>0&&low>=0?y=>y>=boundary?(exactPow(Math.max(0,y-add),1/g)-b)/a:low?(y-base)/low:0:null;
  }
  return {read,inverse,bytes:12+4*count,formula:'para '+form+' '+Array.from(p).join(' ')};
}

function curveStage(curves) {
  return (v,out)=>{for(let c=0;c<curves.length;c++)out[c]=curves[c].read(v[c]);return out;};
}
function matrixStage(m,inputs=3,outputs=3,clip=false) {
  return (v,out)=>{
    for(let y=0;y<outputs;y++){let sum=m[inputs*outputs+y]??0;for(let x=0;x<inputs;x++)sum+=m[y*inputs+x]*v[x];out[y]=clip?clamp(sum):sum;}
    return out;
  };
}
function pipeline(stages,inputs,outputs) {
  const a=new Float64Array(16),b=new Float64Array(16);
  return {inputs,outputs,run(v,out){for(let c=0;c<inputs;c++)a[c]=v[c];let src=a,dst=b;for(const stage of stages){stage(src,dst);const swap=src;src=dst;dst=swap;}for(let c=0;c<outputs;c++)out[c]=src[c];return out;}};
}

function clutStage(grid,outputs,values) {
  const inputs=grid.length,stride=new Array(inputs),frac=new Float64Array(inputs),base=new Uint32Array(inputs);
  let cells=outputs;for(let i=inputs-1;i>=0;i--){requireDecode(grid[i]>=2,'Invalid ICC CLUT grid.');stride[i]=cells;cells*=grid[i];}
  requireDecode(cells===values.length,'Invalid ICC CLUT sample count.');
  const tetra=inputs>=3?inputs-3:inputs;
  return (v,out)=>{
    let index=0;for(let c=0;c<inputs;c++){const x=clamp(v[c])*(grid[c]-1),lo=Math.min(grid[c]-2,Math.floor(x));base[c]=lo;frac[c]=x-lo;index+=lo*stride[c];}
    for(let c=0;c<outputs;c++)out[c]=0;
    const corners=1<<tetra;
    for(let mask=0;mask<corners;mask++) {
      let at=index,weight=1;
      for(let c=0;c<tetra;c++){const high=mask>>c&1;weight*=high?frac[c]:1-frac[c];if(high)at+=stride[c];}
      if(!weight)continue;
      if(inputs<3){for(let c=0;c<outputs;c++)out[c]+=weight*values[at+c];continue;}
      let x=tetra,y=x+1,z=y+1;
      if(frac[x]<frac[y]){const q=x;x=y;y=q;}if(frac[y]<frac[z]){const q=y;y=z;z=q;}if(frac[x]<frac[y]){const q=x;x=y;y=q;}
      const b=at+stride[x],c=b+stride[y],d=c+stride[z],fx=frac[x],fy=frac[y],fz=frac[z];
      for(let k=0;k<outputs;k++)out[k]+=weight*(values[at+k]+fx*(values[b+k]-values[at+k])+fy*(values[c+k]-values[b+k])+fz*(values[d+k]-values[c+k]));
    }
    return out;
  };
}

function parseTag(bytes,tag,budget) {
  const at=tag.offset,end=at+tag.length,view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const has=(p,n)=>requireDecode(p>=at&&n>=0&&p+n<=end,'Truncated ICC color transform.');
  const type=text(bytes,at);has(at,12);
  const fixed=(p,n)=>{has(p,n*4);return budget.numbers(view,p,n,'fixed');};
  const floats=(p,n)=>{has(p,n*4);return budget.numbers(view,p,n,'float');};
  const channels=(p,q)=>requireDecode(p>0&&p<=16&&q>0&&q<=16,'Invalid ICC transform channel count.');
  const curves=(offset,n)=>{let p=at+offset;const out=[];for(let i=0;i<n;i++){has(p,12);const c=curve(view,p,end,budget);out.push(c);p+=align4(c.bytes);}return curveStage(out);};
  const lookup=(p,grid,outputs,precision)=>{
    let n=outputs;for(const count of grid){requireDecode(count>=2,'Invalid ICC lookup dimensions.');n*=count;requireDecode(Number.isSafeInteger(n)&&n<=16777216,'ICC lookup table exceeds the sample limit.');}
    has(p,n*precision);
    const values=budget.numbers(view,p,n,precision===1?'u8':precision===2?'u16':'float');
    return {stage:clutStage(grid,outputs,values),bytes:n*precision};
  };
  if(type==='mft1'||type==='mft2') {
    const inputs=bytes[at+8],outputs=bytes[at+9],grid=bytes[at+10],precision=type==='mft1'?1:2;channels(inputs,outputs);has(at,precision===1?48:52);
    budget.stages(inputs+outputs+(inputs===3?4:3));
    const m=fixed(at+12,9),ni=precision===1?256:view.getUint16(at+48),no=precision===1?256:view.getUint16(at+50);
    requireDecode(ni>=2&&no>=2,'Invalid ICC lookup curve size.');
    let p=at+(precision===1?48:52);
    const tables=(count,n)=>{has(p,count*n*precision);const list=[];for(let c=0;c<count;c++){const data=budget.numbers(view,p,n,precision===1?'u8':'u16');p+=n*precision;list.push(sampledCurve(data));}return curveStage(list);};
    const before=tables(inputs,ni),lut=lookup(p,new Array(inputs).fill(grid),outputs,precision);p+=lut.bytes;const after=tables(outputs,no);
    return {...pipeline([...(inputs===3?[matrixStage(m,3,3,true)]:[]),before,lut.stage,after],inputs,outputs),type};
  }
  if(type==='mAB '||type==='mBA ') {
    has(at,32);const inputs=bytes[at+8],outputs=bytes[at+9];channels(inputs,outputs);
    const reverse=type==='mBA ',count=reverse?inputs:outputs,offsets=Array.from({length:5},(_,i)=>view.getUint32(at+12+i*4));
    budget.stages(offsets.filter(Boolean).length);
    for(const o of offsets)requireDecode(!o||o>=32&&o%4===0&&at+o<end,'Invalid ICC processing offset.');
    const [bo,mo,co,lo,ao]=offsets,stages=[];
    requireDecode(bo&&(!mo||co)&&(!co||mo)&&(!ao||lo)&&(!lo||ao),'Invalid ICC processing elements.');
    const b=curves(bo,count),m=mo?matrixStage(fixed(at+mo,12)):null,c=co?curves(co,count):null,a=ao?curves(ao,reverse?outputs:inputs):null;
    requireDecode(!m||count===3,'Invalid ICC matrix dimensions.');
    let lut=null;
    if(lo){has(at+lo,20);const grid=Array.from(bytes.subarray(at+lo,at+lo+inputs)),precision=bytes[at+lo+16];requireDecode(precision===1||precision===2,'Invalid ICC CLUT precision.');lut=lookup(at+lo+20,grid,outputs,precision).stage;}
    else requireDecode(inputs===outputs,'ICC transform lacks a channel mapping.');
    for(const stage of reverse?[b,m,c,lut,a]:[a,lut,c,m,b])if(stage)stages.push(stage);
    return {...pipeline(stages,inputs,outputs),type};
  }
  if(type==='mpet') {
    has(at,16);const inputs=view.getUint16(at+8),outputs=view.getUint16(at+10),count=view.getUint32(at+12);channels(inputs,outputs);has(at+16,count*8);requireDecode(count>0,'Empty ICC processing pipeline.');
    budget.stages(count);
    const stages=[];let previous=inputs;
    for(let i=0;i<count;i++) {
      const offset=view.getUint32(at+16+i*8),size=view.getUint32(at+20+i*8),p=at+offset,limit=p+size;has(p,size);requireDecode(offset>=16+count*8&&offset%4===0&&size>=12,'Invalid ICC processing element.');
      const id=text(bytes,p),n=view.getUint16(p+8),m=view.getUint16(p+10);channels(n,m);requireDecode(n===previous,'ICC processing channels do not match.');previous=m;
      const localHas=(q,length)=>requireDecode(q>=p&&q+length<=limit,'Truncated ICC processing element.');
      if(id==='matf'){localHas(p+12,4*m*(n+1));stages.push(matrixStage(floats(p+12,m*(n+1)),n,m));}
      else if(id==='clut') {localHas(p+12,16);const grid=Array.from(bytes.subarray(p+12,p+12+n));let length=m*4;for(const v of grid)length*=v;localHas(p+28,length);stages.push(lookup(p+28,grid,m,4).stage);}
      else if(id==='cvst') {
        requireDecode(n===m,'Invalid ICC curve set dimensions.');localHas(p+12,n*8);const list=[];
        budget.stages(n);
        for(let ch=0;ch<n;ch++) {
          const offset=view.getUint32(p+12+ch*8),size=view.getUint32(p+16+ch*8),cp=p+offset,ce=cp+size;localHas(cp,size);
          requireDecode(size>=12&&text(bytes,cp)==='curf','Invalid ICC segmented curve.');
          const segments=view.getUint16(cp+8);requireDecode(segments>0&&cp+8+4*segments<=ce,'Invalid ICC curve segment count.');
          budget.stages(segments);
          const breaks=Array.from(floats(cp+12,segments-1));requireDecode(breaks.every((v,j)=>!j||v>=breaks[j-1]),'Invalid ICC curve break points.');
          const functions=[];let pos=cp+8+4*segments;
          for(let s=0;s<segments;s++) {
            requireDecode(pos+12<=ce,'Truncated ICC curve segment.');const kind=text(bytes,pos);
            if(kind==='parf') {
              const fn=view.getUint16(pos+8),count=fn===0?4:5;requireDecode(fn<=2&&pos+12+count*4<=ce,'Invalid ICC formula curve.');
              const [a,b,c,d,e]=floats(pos+12,count);pos+=12+count*4;
              functions.push(fn===0?x=>exactPow(b*x+c,a)+d:fn===1?x=>b*exactLog(c*exactPow(x,a)+d)/Math.LN10+e:x=>a*exactPow(b,c*x+d)+e);
            } else {
              requireDecode(kind==='samf'&&s>0&&s<segments-1,'Invalid ICC sampled segment.');const count=view.getUint32(pos+8);requireDecode(count>0&&pos+12+count*4<=ce,'Invalid ICC sampled segment size.');
              const left=breaks[s-1],right=breaks[s],values=floats(pos+12,count);budget.allocate(count+1);
              const table=new Float64Array(count+1);table[0]=functions[s-1](left);table.set(values,1);const sample=sampledCurve(table).read;pos+=12+count*4;
              requireDecode(right>left,'Empty ICC sampled interval.');functions.push(x=>sample((x-left)/(right-left)));
            }
          }
          list.push({read(x){let s=0;while(s<breaks.length&&x>breaks[s])s++;return functions[s](x);}});
        }
        stages.push(curveStage(list));
      } else if(id==='bACS'||id==='eACS'){requireDecode(n===m,'Invalid ICC expansion element.');stages.push((v,out)=>{for(let c=0;c<n;c++)out[c]=v[c];return out;});}
      else return null;
    }
    requireDecode(previous===outputs,'ICC output channel count does not match.');return {...pipeline(stages,inputs,outputs),type};
  }
  return null;
}

function decodePCS(v,pcs,type,out) {
  if(type==='mpet'){out[0]=v[0];out[1]=v[1];out[2]=v[2];if(pcs==='Lab ')labXYZ(out);return out;}
  if(pcs==='XYZ '){for(let c=0;c<3;c++)out[c]=v[c]*XYZ_SCALE;return out;}
  const scale=type==='mft2'?LAB_OLD:1;out[0]=v[0]*scale*100;out[1]=v[1]*scale*255-128;out[2]=v[2]*scale*255-128;return labXYZ(out);
}
function encodePCS(v,pcs,type,out) {
  out[0]=v[0];out[1]=v[1];out[2]=v[2];
  if(type==='mpet'){if(pcs==='Lab ')xyzLab(out);return out;}
  if(pcs==='XYZ '){for(let c=0;c<3;c++)out[c]/=XYZ_SCALE;return out;}
  xyzLab(out);const scale=type==='mft2'?LAB_OLD:1;out[0]/=100*scale;out[1]=(out[1]+128)/(255*scale);out[2]=(out[2]+128)/(255*scale);return out;
}

export function readICCColor(icc,{intent,maxSamples=DEFAULT_ICC_SAMPLES,maxStages=DEFAULT_ICC_STAGES}={}) {
  requireDecode(icc instanceof Uint8Array&&icc.length>=132,'Invalid ICC profile for color conversion.');
  requireDecode(Number.isSafeInteger(maxSamples)&&maxSamples>0&&Number.isSafeInteger(maxStages)&&maxStages>0,'Invalid ICC processing limits.');
  const cached=cache.get(icc);if(cached&&cached.intent===intent&&cached.maxSamples===maxSamples&&cached.maxStages===maxStages)return cached.value;
  const budget=profileBudget(maxSamples,maxStages);
  const view=new DataView(icc.buffer,icc.byteOffset,icc.byteLength),length=view.getUint32(0),count=view.getUint32(128);
  requireDecode(length===icc.length&&text(icc,36)==='acsp'&&132+count*12<=length,'Invalid ICC color profile header.');
  const space=text(icc,16),pcs=text(icc,20),tags=new Map(),channels=space==='GRAY'?1:space==='CMYK'?4:3;
  requireDecode(pcs==='XYZ '||pcs==='Lab ','ICC color profile needs an XYZ or Lab connection space.');
  for(let i=0;i<count;i++){const p=132+i*12,offset=view.getUint32(p+4),size=view.getUint32(p+8);requireDecode(offset>=132+count*12&&offset%4===0&&size>=8&&offset+size<=length,'Invalid ICC color tag extent.');tags.set(text(icc,p),{offset,length:size});}
  const selected=intent??view.getUint32(64);requireDecode(selected<=3,'Invalid ICC rendering intent.');
  const choose=prefix=>{
    const names=prefix==='A2B'||prefix==='B2A'?[prefix+(selected===3?1:selected),prefix+'0']:[prefix+selected];
    for(const name of names){const tag=tags.get(name);if(tag){const parsed=parseTag(icc,tag,budget);if(parsed)return parsed;}}
    return null;
  };
  const directForward=choose('D2B'),directReverse=choose('B2D');
  const forward=directForward||choose('A2B'),reverse=directReverse||choose('B2A');
  const temp=new Float64Array(16),xyz=new Float64Array(3);let toPCS=null,fromPCS=null,toModel=null,fromModel=null;
  if(forward){requireDecode(forward.inputs===channels&&forward.outputs===3,'ICC input transform channel count does not match.');toPCS=(v,out)=>decodePCS(forward.run(v,temp),pcs,forward.type,out);}
  if(reverse){requireDecode(reverse.inputs===3&&reverse.outputs===channels,'ICC output transform channel count does not match.');fromPCS=(v,out)=>reverse.run(encodePCS(v,pcs,reverse.type,xyz),out);}
  const readCurve=name=>{const tag=tags.get(name);return tag?curve(view,tag.offset,tag.offset+tag.length,budget):null;};
  if(space==='RGB '&&pcs==='XYZ '&&(!toPCS||!fromPCS)) {
    const columns=['rXYZ','gXYZ','bXYZ'].map(name=>{const t=tags.get(name);return t&&t.length>=20&&text(icc,t.offset)==='XYZ '?[0,1,2].map(c=>view.getInt32(t.offset+8+4*c)/65536):null;});
    const curves=['rTRC','gTRC','bTRC'].map(readCurve);
    if(columns.every(Boolean)&&curves.every(Boolean)) {
      const matrix=[0,1,2].flatMap(row=>columns.map(col=>col[row])),inv=inverse3(matrix);
      const formula=curves.every(c=>c.formula);
      if(!toPCS){toPCS=(v,out)=>{for(let c=0;c<3;c++)xyz[c]=curves[c].read(v[c]);return vector3(matrix,xyz,out);};if(formula)toModel={matrix,curves:curves.map(c=>c.read),keys:curves.map(c=>c.formula)};}
      if(!fromPCS&&curves.every(c=>c.inverse)){fromPCS=(v,out)=>{vector3(inv,v,xyz);for(let c=0;c<3;c++)out[c]=curves[c].inverse(xyz[c]);return out;};if(formula)fromModel={matrix:inv,curves:curves.map(c=>c.inverse),keys:curves.map(c=>'inverse '+c.formula)};}
    }
  } else if(space==='GRAY'&&(!toPCS||!fromPCS)) {
    const c=readCurve('kTRC');
    if(c){if(!toPCS)toPCS=(v,out)=>{const y=c.read(v[0]);for(let k=0;k<3;k++)out[k]=y*D50[k];return out;};if(!fromPCS&&c.inverse)fromPCS=(v,out)=>{out[0]=c.inverse(v[1]);return out;};}
  }
  if(selected===3&&(!directForward||!directReverse)) {
    const white=tags.get('wtpt');
    requireDecode(white&&white.length>=20&&text(icc,white.offset)==='XYZ ','ICC absolute intent needs a media white point.');
    const scale=[0,1,2].map(c=>view.getInt32(white.offset+8+4*c)/65536/D50[c]);
    requireDecode(scale.every(v=>v>0),'Invalid ICC media white point.');
    toModel=fromModel=null;
    if(toPCS&&!directForward){const relative=toPCS;toPCS=(v,out)=>{relative(v,out);for(let c=0;c<3;c++)out[c]*=scale[c];return out;};}
    if(fromPCS&&!directReverse){const relative=fromPCS,adjusted=new Float64Array(3);fromPCS=(v,out)=>{for(let c=0;c<3;c++)adjusted[c]=v[c]/scale[c];return relative(adjusted,out);};}
  }
  const value={space,pcs,channels,toPCS,fromPCS,toModel,fromModel,intent:selected};cache.set(icc,{intent,maxSamples,maxStages,value});return value;
}
