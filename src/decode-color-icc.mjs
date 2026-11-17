// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {D50,inverse3} from './decode-color-math.mjs';
import {CURVE,OP,runVector,curveValue} from './decode-color-program.mjs';

const align4=n=>Math.ceil(n/4)*4;
const text=(b,at)=>String.fromCharCode(b[at],b[at+1],b[at+2],b[at+3]);
const cache=new WeakMap();
const DEFAULT_ICC_SAMPLES=16777216,DEFAULT_ICC_STAGES=256,DEFAULT_ICC_WORK=1024,DEFAULT_ICC_TAGS=4096;

function profileBudget(maxSamples,maxStages,maxWork) {
  let samples=0,stages=0,work=0;const numeric=new Map();
  const limit=message=>{throw Object.assign(new RangeError(message),{code:'JXL_LIMIT'});};
  const allocate=count=>{if(count>maxSamples-samples)limit('ICC samples: over limit');samples+=count;};
  return {
    allocate,
    stages(count=1){if(count>maxStages-stages)limit('ICC stages: over limit');stages+=count;},
    workForPixel(cost,kind='interpolation'){if(!Number.isSafeInteger(cost)||cost>maxWork-work)limit('ICC '+kind+' work: over limit');work+=cost;},
    numbers(view,at,count,kind) {
      const key=kind+':'+at+':'+count;let values=numeric.get(key);if(values)return values;
      allocate(count);
      values=Float64Array.from({length:count},(_,i)=>{
        if(kind==='u8')return view.getUint8(at+i)/255;
        if(kind==='u16')return view.getUint16(at+i*2)/65535;
        if(kind==='fixed')return view.getInt32(at+i*4)/65536;
        const value=view.getFloat32(at+i*4);requireDecode(Number.isFinite(value),'ICC parameter: nonfinite');return value;
      });
      numeric.set(key,values);return values;
    },
  };
}

function sampledCurve(table) {
  const monotone=table.every((v,i)=>!i||v>=table[i-1]);
  return {read:{kind:CURVE.sampled,table},inverse:monotone?{kind:CURVE.sampledInverse,table}:null};
}
const IDENTITY={kind:CURVE.identity};
function curve(view,at,end,budget) {
  budget.stages();
  const has=n=>requireDecode(at+n<=end,'truncated ICC curve');has(12);
  const tag=view.getUint32(at);
  const power=(g,bytes,formula)=>({read:g===1?IDENTITY:{kind:CURVE.iccGamma,p:[g]},inverse:g===1?IDENTITY:{kind:CURVE.iccGamma,p:[1/g]},bytes,formula});
  if(tag===0x63757276) {
    const n=view.getUint32(at+8);has(12+n*2);
    if(!n)return {read:IDENTITY,inverse:IDENTITY,bytes:12,formula:'identity'};
    if(n===1){const g=view.getUint16(at+12)/256;requireDecode(g>0,'ICC curve gamma');return power(g,14,'gamma '+g);}
    const table=budget.numbers(view,at+12,n,'u16');
    return {...sampledCurve(table),bytes:12+n*2};
  }
  requireDecode(tag===0x70617261,'ICC curve type');
  const form=view.getUint16(at+8),count=[1,3,4,5,7][form];
  requireDecode(count!==undefined,'ICC parametric curve');has(12+4*count);
  const p=budget.numbers(view,at+12,count,'fixed');
  const [g,a=1,b=0,c=0,d=0,e=0,f=0]=p;requireDecode(g>0,'ICC curve exponent');
  const formula='para '+form+' '+Array.from(p).join(' ');
  if(form===0)return power(g,12+4*count,formula);
  requireDecode(a!==0,'ICC curve scale');
  const cut=form<=2?-b/a:d,add=form===2?c:form===4?e:0,low=form>=3?c:0,base=form===2?c:form===4?f:0;
  const boundary=Math.pow(Math.max(0,a*cut+b),g)+add;
  return {read:{kind:CURVE.para,p:[g,a,b,cut,add,low,base]},inverse:a>0&&low>=0?{kind:CURVE.paraInverse,p:[1/g,a,b,boundary,add,low,base]}:null,bytes:12+4*count,formula};
}

const curveStage=curves=>curves.map((c,i)=>({op:OP.curve,a:i,curve:c.read}));
const matrixStage=(m,inputs=3,outputs=3,clip=false)=>[{op:OP.matrix,a:inputs,b:outputs,c:clip?1:0,d:m.length>inputs*outputs?1:0,data:Float64Array.from(m)}];
const pipeline=(stages,inputs,outputs)=>({inputs,outputs,ops:stages.flat()});

function clutStage(grid,outputs,values) {
  let cells=outputs;for(let i=grid.length-1;i>=0;i--){requireDecode(grid[i]>=2,'ICC CLUT grid');cells*=grid[i];}
  requireDecode(cells===values.length,'ICC CLUT samples');
  return [{op:OP.clut,a:grid.length,b:outputs,grid:Int32Array.from(grid),data:values}];
}

function parseTag(bytes,tag,budget) {
  const at=tag.offset,end=at+tag.length,view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const has=(p,n)=>requireDecode(p>=at&&n>=0&&p+n<=end,'truncated ICC transform');
  const type=text(bytes,at);has(at,12);
  const fixed=(p,n)=>{has(p,n*4);return budget.numbers(view,p,n,'fixed');};
  const floats=(p,n)=>{has(p,n*4);return budget.numbers(view,p,n,'float');};
  const channels=(p,q)=>requireDecode(p>0&&p<=16&&q>0&&q<=16,'ICC transform channels');
  const curves=(offset,n)=>{let p=at+offset;const out=[];for(let i=0;i<n;i++){has(p,12);const c=curve(view,p,end,budget);out.push(c);p+=align4(c.bytes);}return curveStage(out);};
  const lookup=(p,grid,outputs,precision)=>{
    let n=outputs;for(const count of grid){requireDecode(count>=2,'ICC lookup dimensions');n*=count;requireDecode(Number.isSafeInteger(n)&&n<=16777216,'ICC lookup samples: over limit');}
    const multilinear=grid.length>=3?grid.length-3:grid.length;
    budget.workForPixel((1<<multilinear)*(grid.length+4*outputs));
    has(p,n*precision);
    const values=budget.numbers(view,p,n,precision===1?'u8':precision===2?'u16':'float');
    return {stage:clutStage(grid,outputs,values),bytes:n*precision};
  };
  if(type==='mft1'||type==='mft2') {
    const inputs=bytes[at+8],outputs=bytes[at+9],grid=bytes[at+10],precision=type==='mft1'?1:2;channels(inputs,outputs);has(at,precision===1?48:52);
    budget.stages(inputs+outputs+(inputs===3?4:3));
    const m=fixed(at+12,9),ni=precision===1?256:view.getUint16(at+48),no=precision===1?256:view.getUint16(at+50);
    requireDecode(ni>=2&&no>=2,'ICC lookup curve');
    let p=at+(precision===1?48:52);
    const tables=(count,n)=>{has(p,count*n*precision);const list=[];for(let c=0;c<count;c++){const data=budget.numbers(view,p,n,precision===1?'u8':'u16');p+=n*precision;list.push(sampledCurve(data));}return curveStage(list);};
    const before=tables(inputs,ni),lut=lookup(p,new Array(inputs).fill(grid),outputs,precision);p+=lut.bytes;const after=tables(outputs,no);
    return {...pipeline([...(inputs===3?[matrixStage(m,3,3,true)]:[]),before,lut.stage,after],inputs,outputs),type};
  }
  if(type==='mAB '||type==='mBA ') {
    has(at,32);const inputs=bytes[at+8],outputs=bytes[at+9];channels(inputs,outputs);
    const reverse=type==='mBA ',count=reverse?inputs:outputs,offsets=Array.from({length:5},(_,i)=>view.getUint32(at+12+i*4));
    budget.stages(offsets.filter(Boolean).length);
    for(const o of offsets)requireDecode(!o||o>=32&&o%4===0&&at+o<end,'ICC element offset');
    const [bo,mo,co,lo,ao]=offsets,stages=[];
    requireDecode(bo&&(!mo||co)&&(!co||mo)&&(!ao||lo)&&(!lo||ao),'ICC elements');
    const b=curves(bo,count),m=mo?matrixStage(fixed(at+mo,12)):null,c=co?curves(co,count):null,a=ao?curves(ao,reverse?outputs:inputs):null;
    requireDecode(!m||count===3,'ICC matrix dimensions');
    let lut=null;
    if(lo){has(at+lo,20);const grid=Array.from(bytes.subarray(at+lo,at+lo+inputs)),precision=bytes[at+lo+16];requireDecode(precision===1||precision===2,'ICC CLUT precision');lut=lookup(at+lo+20,grid,outputs,precision).stage;}
    else requireDecode(inputs===outputs,'ICC channel mapping');
    for(const stage of reverse?[b,m,c,lut,a]:[a,lut,c,m,b])if(stage)stages.push(stage);
    return {...pipeline(stages,inputs,outputs),type};
  }
  if(type==='mpet') {
    has(at,16);const inputs=view.getUint16(at+8),outputs=view.getUint16(at+10),count=view.getUint32(at+12);channels(inputs,outputs);has(at+16,count*8);requireDecode(count>0,'ICC pipeline: empty');
    budget.stages(count);
    const stages=[];let previous=inputs;
    for(let i=0;i<count;i++) {
      const offset=view.getUint32(at+16+i*8),size=view.getUint32(at+20+i*8),p=at+offset,limit=p+size;has(p,size);requireDecode(offset>=16+count*8&&offset%4===0&&size>=12,'ICC element');
      const id=text(bytes,p),n=view.getUint16(p+8),m=view.getUint16(p+10);channels(n,m);requireDecode(n===previous,'ICC stage channels');previous=m;
      const localHas=(q,length)=>requireDecode(q>=p&&q+length<=limit,'truncated ICC element');
      if(id==='matf'){
        localHas(p+12,4*m*(n+1));
        budget.workForPixel(m*(n+1),'processing');
        stages.push(matrixStage(floats(p+12,m*(n+1)),n,m));
      }
      else if(id==='clut') {localHas(p+12,16);const grid=Array.from(bytes.subarray(p+12,p+12+n));let length=m*4;for(const v of grid)length*=v;localHas(p+28,length);stages.push(lookup(p+28,grid,m,4).stage);}
      else if(id==='cvst') {
        requireDecode(n===m,'ICC curve set channels');budget.workForPixel(n,'processing');localHas(p+12,n*8);const list=[];
        budget.stages(n);
        for(let ch=0;ch<n;ch++) {
          const offset=view.getUint32(p+12+ch*8),size=view.getUint32(p+16+ch*8),cp=p+offset,ce=cp+size;localHas(cp,size);
          requireDecode(size>=12&&text(bytes,cp)==='curf','ICC segmented curve');
          const segments=view.getUint16(cp+8);requireDecode(segments>0&&cp+8+4*segments<=ce,'ICC curve segments');
          budget.stages(segments);
          const breaks=Array.from(floats(cp+12,segments-1));requireDecode(breaks.every((v,j)=>!j||v>=breaks[j-1]),'ICC curve breaks');
          const segmentList=[];let pos=cp+8+4*segments;
          for(let s=0;s<segments;s++) {
            requireDecode(pos+12<=ce,'truncated ICC segment');const kind=text(bytes,pos);
            if(kind==='parf') {
              const fn=view.getUint16(pos+8),count=fn===0?4:5;requireDecode(fn<=2&&pos+12+count*4<=ce,'ICC formula curve');
              segmentList.push({kind:fn,p:Array.from(floats(pos+12,count))});pos+=12+count*4;
            } else {
              requireDecode(kind==='samf'&&s>0&&s<segments-1,'ICC sampled segment');const count=view.getUint32(pos+8);requireDecode(count>0&&pos+12+count*4<=ce,'ICC sampled segment size');
              const left=breaks[s-1],right=breaks[s],values=floats(pos+12,count);budget.allocate(count+1);
              const table=new Float64Array(count+1);table[0]=curveValue({kind:CURVE.segmented,breaks:[],segments:[segmentList[s-1]]},left);table.set(values,1);pos+=12+count*4;
              requireDecode(right>left,'ICC sampled interval');segmentList.push({kind:3,p:[left,right],table});
            }
          }
          list.push({read:{kind:CURVE.segmented,breaks:Float64Array.from(breaks),segments:segmentList}});
        }
        stages.push(curveStage(list));
      } else if(id==='bACS'||id==='eACS'){requireDecode(n===m,'ICC expansion element');budget.workForPixel(n,'processing');}
      else return null;
    }
    requireDecode(previous===outputs,'ICC output channels');return {...pipeline(stages,inputs,outputs),type};
  }
  return null;
}

const pcsKind=(pcs,type)=>({a:pcs==='Lab '?1:0,b:type==='mpet'?2:type==='mft2'?1:0});
const decodePCS=(pcs,type)=>({op:OP.decodePCS,...pcsKind(pcs,type)});
const encodePCS=(pcs,type)=>({op:OP.encodePCS,...pcsKind(pcs,type)});
const vectorFunction=(ops,outputs)=>Object.assign((v,out=[])=>{const result=runVector(ops,v);for(let c=0;c<outputs;c++)out[c]=result[c];return out;},{ops});

export function readICCColor(icc,{intent,maxSamples=DEFAULT_ICC_SAMPLES,maxStages=DEFAULT_ICC_STAGES,maxWork=DEFAULT_ICC_WORK,maxTags=DEFAULT_ICC_TAGS}={}) {
  requireDecode(icc instanceof Uint8Array&&icc.length>=132,'ICC profile');
  requireDecode(Number.isSafeInteger(maxSamples)&&maxSamples>0&&Number.isSafeInteger(maxStages)&&maxStages>0&&Number.isSafeInteger(maxWork)&&maxWork>0&&Number.isSafeInteger(maxTags)&&maxTags>0,'ICC limits: positive integers');
  const cached=cache.get(icc);if(cached&&cached.intent===intent&&cached.maxSamples===maxSamples&&cached.maxStages===maxStages&&cached.maxWork===maxWork&&cached.maxTags===maxTags)return cached.value;
  const budget=profileBudget(maxSamples,maxStages,maxWork);
  const view=new DataView(icc.buffer,icc.byteOffset,icc.byteLength),length=view.getUint32(0),count=view.getUint32(128);
  requireDecode(length===icc.length&&text(icc,36)==='acsp'&&132+count*12<=length,'ICC header');
  if(count>maxTags)throw Object.assign(new RangeError('ICC tags: over limit'),{code:'JXL_LIMIT'});
  const space=text(icc,16),pcs=text(icc,20),tags=new Map(),channels=space==='GRAY'?1:space==='CMYK'?4:3;
  requireDecode(pcs==='XYZ '||pcs==='Lab ','ICC PCS: XYZ or Lab');
  for(let i=0;i<count;i++){const p=132+i*12,offset=view.getUint32(p+4),size=view.getUint32(p+8);requireDecode(offset>=132+count*12&&offset%4===0&&size>=8&&offset+size<=length,'ICC tag extent');tags.set(text(icc,p),{offset,length:size});}
  const selected=intent??view.getUint32(64);requireDecode(selected<=3,'ICC rendering intent');
  const choose=prefix=>{
    const names=prefix==='A2B'||prefix==='B2A'?[prefix+(selected===3?1:selected),prefix+'0']:[prefix+selected];
    for(const name of names){const tag=tags.get(name);if(tag){const parsed=parseTag(icc,tag,budget);if(parsed)return parsed;}}
    return null;
  };
  const directForward=choose('D2B'),directReverse=choose('B2D');
  const forward=directForward||choose('A2B'),reverse=directReverse||choose('B2A');
  let toPCS=null,fromPCS=null,toModel=null,fromModel=null;
  if(forward){requireDecode(forward.inputs===channels&&forward.outputs===3,'ICC input channels');toPCS=[...forward.ops,decodePCS(pcs,forward.type)];}
  if(reverse){requireDecode(reverse.inputs===3&&reverse.outputs===channels,'ICC output channels');fromPCS=[encodePCS(pcs,reverse.type),...reverse.ops];}
  const readCurve=name=>{const tag=tags.get(name);return tag?curve(view,tag.offset,tag.offset+tag.length,budget):null;};
  if(space==='RGB '&&pcs==='XYZ '&&(!toPCS||!fromPCS)) {
    const columns=['rXYZ','gXYZ','bXYZ'].map(name=>{const t=tags.get(name);return t&&t.length>=20&&text(icc,t.offset)==='XYZ '?[0,1,2].map(c=>view.getInt32(t.offset+8+4*c)/65536):null;});
    const curves=['rTRC','gTRC','bTRC'].map(readCurve);
    if(columns.every(Boolean)&&curves.every(Boolean)) {
      const matrix=[0,1,2].flatMap(row=>columns.map(col=>col[row])),inv=inverse3(matrix);
      const formula=curves.every(c=>c.formula);
      if(!toPCS){toPCS=[...curves.map((c,i)=>({op:OP.curve,a:i,curve:c.read})),{op:OP.vector3,data:Float64Array.from(matrix)}];if(formula)toModel={matrix,curves:curves.map(c=>c.read),keys:curves.map(c=>c.formula)};}
      if(!fromPCS&&curves.every(c=>c.inverse)){fromPCS=[{op:OP.vector3,data:Float64Array.from(inv)},...curves.map((c,i)=>({op:OP.curve,a:i,curve:c.inverse}))];if(formula)fromModel={matrix:inv,curves:curves.map(c=>c.inverse),keys:curves.map(c=>'inverse '+c.formula)};}
    }
  } else if(space==='GRAY'&&(!toPCS||!fromPCS)) {
    const c=readCurve('kTRC');
    if(c){if(!toPCS)toPCS=[{op:OP.curve,a:0,curve:c.read},{op:OP.grayD50}];if(!fromPCS&&c.inverse)fromPCS=[{op:OP.copy,a:0,b:1},{op:OP.curve,a:0,curve:c.inverse}];}
  }
  if(selected===3&&(!directForward||!directReverse)) {
    const white=tags.get('wtpt');
    requireDecode(white&&white.length>=20&&text(icc,white.offset)==='XYZ ','ICC white point');
    const scale=[0,1,2].map(c=>view.getInt32(white.offset+8+4*c)/65536/D50[c]);
    requireDecode(scale.every(v=>v>0),'ICC white point');
    toModel=fromModel=null;
    if(toPCS&&!directForward)toPCS=[...toPCS,{op:OP.scale,data:Float64Array.from(scale)}];
    if(fromPCS&&!directReverse)fromPCS=[{op:OP.divide,data:Float64Array.from(scale)},...fromPCS];
  }
  toPCS=toPCS&&vectorFunction(toPCS,3);fromPCS=fromPCS&&vectorFunction(fromPCS,channels);
  const value={space,pcs,channels,toPCS,fromPCS,toModel,fromModel,intent:selected};cache.set(icc,{intent,maxSamples,maxStages,maxWork,maxTags,value});return value;
}
