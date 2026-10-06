// SPDX-License-Identifier: MIT
// Deterministic scale run of the public mutation grammar. Cache hits still execute the encoder;
// only identical compressed streams reuse decoder evidence. Counts distinguish all three layers.
// node test/fuzz-scale.mjs --out fuzz-run --jpegs 2000000 --pixels 32768 [--lock path]
import assert from 'node:assert/strict';
import {readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, openSync, writeSync, closeSync, statSync, truncateSync, fstatSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {encode} from '../src/index.mjs';
import {transcode} from '../src/jpeg.mjs';
import {encodePhoto} from '../src/photo.mjs';
import {decoder} from './decoder.mjs';
import {nativeDecoder} from './native-decoder.mjs';
import {jxlRsDecoder, decoderDifference} from './jxl-rs-decoder.mjs';
import {rgbaOf} from './oracles.mjs';
import {rng, scaleJPEG, pixelCase, mutationKinds, guardJPEGPlanes} from './fuzz-cases.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--out','--jpegs','--pixels','--seed','--lock','--seconds','--jpeg-start','--pixel-start','--one-chunk','--reuse','--against'].includes(args[i]) && args[i + 1], 'Unknown or incomplete argument: ' + args[i]);
  options[args[i].slice(2)] = args[i + 1];
}
const number = (name, fallback) => { const value = Number(options[name] ?? fallback); assert.ok(Number.isSafeInteger(value) && value >= 0, 'Invalid ' + name); return value; };
const root = resolve(options.out || 'fuzz-run'), config = {seed: number('seed',20260930), jpegs:number('jpegs',2000000), pixels:number('pixels',32768), jpegStart:number('jpeg-start',0),pixelStart:number('pixel-start',0),compactPixels:'255 in 256; every 256th uses full block/group/strip sizes'};
assert.ok(config.jpegStart<=config.jpegs&&config.pixelStart<=config.pixels,'Mutation ranges must be ordered');
const seconds = number('seconds',25); assert.ok(seconds >= 1 && seconds <= 30, 'Chunks are from 1 to 30 seconds');
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), alphaHash = rgba => { const alpha = new Uint8Array(rgba.length / 4); for(let i=0;i<alpha.length;i++)alpha[i]=rgba[i*4+3];return hash(alpha); };
const readJSON = name => JSON.parse(readFileSync(join(root,name),'utf8'));
mkdirSync(root,{recursive:true});
const grammar = hash(readFileSync(new URL('./fuzz-cases.mjs',import.meta.url)));
const harness = Object.fromEntries(['fuzz-scale.mjs','native-decoder.mjs','native-decoder.c','jxl-rs-decoder.mjs','jxl-rs-decoder.rs'].map(name=>[name,hash(readFileSync(new URL(name,import.meta.url)))]));
let state = existsSync(join(root,'progress.json')) ? readJSON('progress.json') : {
  config, grammar, jpeg:config.jpegStart,pixel:config.pixelStart,mutatedInputs:0,returnedStreams:0,cacheHits:0,refusals:{},
  jpegKinds:Object.fromEntries(mutationKinds.map(kind=>[kind,{mutations:0,returned:0,refused:0}])),
  pixelKinds:{},paths:{},differences:{},sources:[],cpuSeconds:0,elapsedSeconds:0,failures:0,
};
assert.deepEqual(state.config,config,'Resume uses the exact original budget and seed');assert.equal(state.grammar,grammar,'Resume uses the exact original mutation grammar');
if(state.harness)assert.deepEqual(state.harness,harness,'Resume uses the same harness and native protocol');state.harness=harness;
// A process can stop between appending proof bytes and publishing a checkpoint. Resume from
// the last complete mutation, discarding only this runner's uncommitted journal suffixes.
for(const [name,length] of Object.entries(state.journalBytes||{})){
  const path=join(root,name);assert.ok(statSync(path).size>=length,'A checkpoint journal was truncated');truncateSync(path,length);
}
const uniqueInputs = new Set(existsSync(join(root,'inputs.txt')) ? readFileSync(join(root,'inputs.txt'),'utf8').trim().split('\n').filter(Boolean) : []);
const rows = path => existsSync(path) ? readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const priorRows=options.reuse?rows(join(resolve(options.reuse),'streams.jsonl')):[];
const localRows=rows(join(root,'streams.jsonl')),cache=new Map([...priorRows,...localRows].map(row=>[row.key,row]));
const initialEvidence=options.reuse?{directory:resolve(options.reuse),sha256:hash(readFileSync(join(resolve(options.reuse),'streams.jsonl'))),streams:priorRows.length}:null;
if(state.initialEvidence!==undefined)assert.deepEqual(state.initialEvidence,initialEvidence,'The reused proof cache must not change during a run');state.initialEvidence=initialEvidence;
let decodedHere=localRows.length;
const usedStreams=new Set(existsSync(join(root,'used-streams.txt'))?readFileSync(join(root,'used-streams.txt'),'utf8').trim().split('\n').filter(Boolean):[]);
const outcomes=new Map(rows(join(root,'outcomes.jsonl')).map(row=>[row.input,row]));
const inputsFile=openSync(join(root,'inputs.txt'),'a'),streamsFile=openSync(join(root,'streams.jsonl'),'a'),usedFile=openSync(join(root,'used-streams.txt'),'a'),outcomesFile=openSync(join(root,'outcomes.jsonl'),'a');
const sources = Object.fromEntries(['bits','prefix','modular','frame','squeeze','lossless','lossy','jfif','jpeg','entropy','vardct','admit','index','photo'].map(name=>[name,hash(readFileSync(new URL('../src/'+name+'.mjs',import.meta.url)))]));
const sourceHash=hash(JSON.stringify(sources));
if(state.sources.at(-1)?.sha256!==sourceHash)state.sources.push({sha256:sourceHash,modules:sources,fromJPEG:state.jpeg,fromPixel:state.pixel});
let against;
if(options.against){const base=resolve(options.against);against={...await import(pathToFileURL(join(base,'index.mjs'))),...await import(pathToFileURL(join(base,'photo.mjs'))),...(existsSync(join(base,'jfif.mjs'))?await import(pathToFileURL(join(base,'jpeg.mjs'))):{})};against.encodePhoto||=against.encodePhotoRGBA;
  const baseline=Object.fromEntries(Object.keys(sources).filter(name=>existsSync(join(base,name+'.mjs'))).map(name=>[name,hash(readFileSync(join(base,name+'.mjs')))]));
  const identity=hash(JSON.stringify(baseline));if(state.against)assert.equal(state.against.sha256,identity,'The differential baseline must not change');state.against={directory:base,sha256:identity,modules:baseline};
}
state.comparison ||= {identical:0,changed:0,refusalChanges:0};
state.floatDecoderExecutions ||= 0;
const checkpoint = () => {
  state.uniqueInputs=uniqueInputs.size;state.uniqueReturnedStreams=usedStreams.size;state.uniqueOracleDecodes={oxide:decodedHere,native:decodedHere,jxlRs:rust?decodedHere:0};
  state.complete=state.jpeg===config.jpegs&&state.pixel===config.pixels;
  state.journalBytes=Object.fromEntries([['inputs.txt',inputsFile],['streams.jsonl',streamsFile],['used-streams.txt',usedFile],['outcomes.jsonl',outcomesFile]].map(([name,file])=>[name,fstatSync(file).size]));
  writeFileSync(join(root,'progress.json.new'),JSON.stringify(state,null,2)+'\n');renameSync(join(root,'progress.json.new'),join(root,'progress.json'));
};
const rememberInput = bytes => {const key=hash(bytes);if(!uniqueInputs.has(key)){uniqueInputs.add(key);writeSync(inputsFile,key+'\n');}return key;};
const cases = JSON.parse(readFileSync(new URL('./seeds/cases.json',import.meta.url),'utf8')).filter(row=>!row.code&&row.scaleSeed!==false).map(row=>({...row,bytes:new Uint8Array(readFileSync(new URL('./seeds/'+row.file,import.meta.url)))}));
const seedFiles=Object.fromEntries(cases.map(row=>[row.file,hash(row.bytes)]));if(state.seedFiles)assert.deepEqual(state.seedFiles,seedFiles,'The input seeds must not change during a run');state.seedFiles=seedFiles;
const oxide = await decoder();assert.ok(oxide,'jxl-oxide-wasm@0.12.6 is required');assert.match(oxide.version,/(?:^|\D)0\.12\.6(?:$|\D)/);
const native=await nativeDecoder(),rustInfo=jxlRsDecoder(),rust=rustInfo?await rustInfo.persistent():null;
const oracleIdentity={oxide:oxide.version,native:'libjxl '+native.version,jxlRs:rustInfo?.version||null,
  ...(rustInfo?{jxlRsBinary:hash(readFileSync(rustInfo.executable))}:{})};
if(state.oracles)assert.deepEqual(state.oracles,oracleIdentity,'Resume uses the same decoder identities and optional availability');
state.oracles=oracleIdentity;state.jxlRsUnavailable=!rust;
if(options.reuse){const previous=JSON.parse(readFileSync(join(resolve(options.reuse),'progress.json'),'utf8'));assert.deepEqual(previous.oracles,state.oracles,'Reused evidence must use identical decoder identities and optional availability');}
const namedCodes = new Set(['JXL_INPUT','JXL_DIMENSIONS','JXL_SIZE','JXL_MEMORY','JXL_JPEG']);
let active,resultBytes,floatNative,stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const retain = (name, metadata) => {
  const ext=active.type==='jpeg'?'.jpg':'.rgba';writeFileSync(join(root,name+ext),active.bytes);
  if(resultBytes)writeFileSync(join(root,name+'.jxl'),resultBytes);
  writeFileSync(join(root,name+'.json'),JSON.stringify({...active,bytes:undefined,...metadata},null,2)+'\n');
};
async function verify(bytes,width,height,path,exact,alpha) {
  resultBytes=bytes;const key=hash(bytes);let entry=cache.get(key);
  if(!entry || entry.different && !entry.rounding) {
    const image=oxide(bytes);assert.equal(image.width,width,'oxide width');assert.equal(image.height,height,'oxide height');
    const rgba=rgbaOf(image), second=await native.decode(bytes,width,height);
    let maximum=0, different=0, alphaDifferent=0;const channels=[0,0,0,0];
    for(let i=0;i<rgba.length;i++){const delta=Math.abs(rgba[i]-second[i]);if(delta){channels[i%4]++;different++;maximum=Math.max(maximum,delta);if(i%4===3)alphaDifferent++;}}
    entry={key,width,height,oxide:hash(rgba),native:hash(second),oxideAlpha:alphaHash(rgba),nativeAlpha:alphaHash(second),maximum,different,channels,alphaDifferent,firstInput:{...active,bytes:undefined,outputs:undefined}};
    if(rust){
      const third=await rust.decode(bytes,width,height);
      const oxideDifference=decoderDifference(third,rgba),nativeDifference=decoderDifference(third,second);
      entry.jxlRs=hash(third);entry.jxlRsAlpha=alphaHash(third);entry.jxlRsDifferences={oxide:oxideDifference,native:nativeDifference};
      for(const [name,difference]of Object.entries(entry.jxlRsDifferences)){
        assert.equal(difference.alpha,0,'jxl-rs disagrees with '+name+' about alpha');
        assert.ok(difference.maximum<=(exact?0:1),'jxl-rs RGB disagrees with '+name+' by '+difference.maximum);
      }
    }
    assert.equal(alphaDifferent,0,'The decoders disagree about alpha');
    if(different) {
      const id=path+':'+maximum, tally=state.differences[id] ||= {streams:0,pixelsOrChannels:0,maximum,channels:[0,0,0,0],example:'difference-'+path+'-'+maximum};
      if(!tally.streams)retain(tally.example,{path,entry});tally.streams++;tally.pixelsOrChannels+=different;channels.forEach((n,i)=>tally.channels[i]+=n);
      // VarDCT differences are retained and quantified for arithmetic investigation. Integer
      // modular differences are always defects; >1 VarDCT differences stop for investigation.
      assert.ok(path==='jpeg'||path==='photo','Integer modular decoders disagree');assert.ok(maximum<=1,'VarDCT decoders disagree by more than one sample');
      floatNative ||= await nativeDecoder({float:true});assert.equal(floatNative.version,native.version);
      const samples=await floatNative.decode(bytes,width,height),rounding={integerTie:0,reconstruction:0,examples:[]};
      state.floatDecoderExecutions++;
      for(let i=0;i<rgba.length;i++)if(rgba[i]!==second[i]){
        const scaled=Math.fround(samples[i]*255),base=Math.floor(scaled),part=scaled-base;
        const even=Math.max(0,Math.min(255,part===0.5?base+(base%2):Math.round(scaled)));
        const halfUp=Math.max(0,Math.min(255,Math.trunc(Math.fround(scaled+0.5))));
        const classification=halfUp===rgba[i]&&even===second[i]?'integerTie':'reconstruction';rounding[classification]++;
        if(!rounding.examples.some(row=>row.classification===classification))rounding.examples.push({sample:i,oxide:rgba[i],native:second[i],nativeFloat:samples[i],scaledFloat32:scaled,halfUp,nearestEven:even,classification});
      }
      entry.rounding=rounding;
    }
    cache.set(key,entry);writeSync(streamsFile,JSON.stringify(entry)+'\n');decodedHere++;
  } else state.cacheHits++;
  assert.equal(entry.width,width);assert.equal(entry.height,height);
  if(exact){const wanted=hash(exact);assert.equal(entry.oxide,wanted,'oxide changed lossless pixels');assert.equal(entry.native,wanted,'libjxl changed lossless pixels');}
  if(alpha){const wanted=alphaHash(alpha);assert.equal(entry.oxideAlpha,wanted,'oxide changed exact alpha');assert.equal(entry.nativeAlpha,wanted,'libjxl changed exact alpha');}
  if(rust){assert(entry.jxlRs,'Every reused stream needs the configured jxl-rs proof');if(exact)assert.equal(entry.jxlRs,hash(exact),'jxl-rs changed lossless pixels');if(alpha)assert.equal(entry.jxlRsAlpha,alphaHash(alpha),'jxl-rs changed exact alpha');}
  state.returnedStreams++;state.paths[path]=(state.paths[path]||0)+1;
  if(!usedStreams.has(key)){usedStreams.add(key);writeSync(usedFile,key+'\n');}active.outputs.push(key);
}
function outcome() {
  let known=outcomes.get(active.key), baseline=known?.baseline;
  if(against&&!baseline){
    if(active.type==='jpeg'){
      try{const value=guardJPEGPlanes(()=>against.transcode(active.bytes));baseline={outputs:[hash(value.bytes)]};}
      catch(error){if(!namedCodes.has(error.code))throw error;baseline={refusal:error.code,outputs:[]};}
    }else baseline={outputs:[hash(against.encode(active.bytes,active.width,active.height)),hash(against.encode(active.bytes,active.width,active.height,{quality:active.quality})),hash(against.encodePhoto(active.bytes,active.width,active.height,{quality:active.quality}))]};
  }
  const actual={outputs:active.outputs,...(active.refusal?{refusal:active.refusal}:{})};
  if(known)assert.deepEqual(known.actual,actual,'The same input must have a deterministic outcome');
  else{known={input:active.key,actual,...(baseline?{baseline}:{})};outcomes.set(active.key,known);writeSync(outcomesFile,JSON.stringify(known)+'\n');}
  if(baseline){
    if(baseline.refusal===actual.refusal&&baseline.outputs.join(',')===actual.outputs.join(','))state.comparison.identical++;else state.comparison.changed++;
    if(baseline.refusal!==actual.refusal){state.comparison.refusalChanges++;retain('changed-refusal-'+active.type+'-'+active.index,{baseline,actual});throw new Error('Differential encoding changed its refusal boundary');}
    // A different JPEG entropy encoding must still carry the same coefficients/pixels. Pixel
    // lossy defaults may change RGB, but verify() independently protects exact lossless/alpha.
    if(active.type==='jpeg'&&baseline.outputs[0]!==actual.outputs[0]){
      const previous=cache.get(baseline.outputs[0]),current=cache.get(actual.outputs[0]);assert.ok(previous,'Changed JPEG needs its baseline decoder evidence');
      assert.equal(previous.oxide,current.oxide,'JPEG pixel change in oxide');assert.equal(previous.native,current.native,'JPEG pixel change in libjxl');
    }
  }
}
async function acquire() {
  if(!options.lock)return async()=>{};
  const child=spawn('flock',['-x',resolve(options.lock),'sh','-c','printf "locked\\n"; cat >/dev/null'],{stdio:['pipe','pipe','inherit']});
  await new Promise((accept,reject)=>{child.once('error',reject);child.stdout.once('data',accept);child.once('exit',code=>{if(code)reject(new Error('Benchmark lock failed: '+code));});});
  return ()=>new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',code=>code?reject(new Error('Benchmark unlock failed')):accept());child.stdin.end();});
}
try {
  while(!state.complete&&!stopping) {
    const release=await acquire(), started=performance.now(), usage=process.cpuUsage();
    try {
      while(!stopping&&performance.now()-started<seconds*1000&&(state.jpeg<config.jpegs||state.pixel<config.pixels)) {
        resultBytes=null;
        if(state.jpeg<config.jpegs) {
          const index=state.jpeg, random=rng((config.seed^Math.imul(index+1,0x85ebca6b))>>>0), input=cases[Math.floor(random()*cases.length)], mutation=scaleJPEG(input.bytes,config.seed,index);
          active={type:'jpeg',seed:config.seed,index,source:input.file,kind:mutation.kind,bytes:mutation.bytes,outputs:[]};active.key=rememberInput(mutation.bytes);
          let output;
          try { output=guardJPEGPlanes(()=>transcode(mutation.bytes)); }
          catch(error){if(!namedCodes.has(error.code))throw error;active.refusal=error.code;state.refusals[error.code]=(state.refusals[error.code]||0)+1;state.jpegKinds[mutation.kind].refused++;}
          if(output){await verify(output.bytes,output.width,output.height,'jpeg');state.jpegKinds[mutation.kind].returned++;}
          outcome();state.jpegKinds[mutation.kind].mutations++;state.jpeg++;
        } else {
          const index=state.pixel, input=pixelCase(config.seed,index,{compact:index%256!==0});
          active={type:'pixels',seed:config.seed,index,width:input.width,height:input.height,quality:input.quality,kind:input.kind,bytes:input.rgba,outputs:[]};
          active.key=rememberInput(Buffer.concat([Buffer.from(`${input.width},${input.height},${input.quality}:`),input.rgba]));
          await verify(encode(input.rgba,input.width,input.height),input.width,input.height,'lossless',input.rgba,input.rgba);
          await verify(encode(input.rgba,input.width,input.height,{quality:input.quality}),input.width,input.height,'modular',input.quality===100?input.rgba:null,input.rgba);
          await verify(encodePhoto(input.rgba,input.width,input.height,{quality:input.quality}),input.width,input.height,'photo',input.quality===100?input.rgba:null,input.rgba);
          outcome();state.pixelKinds[input.kind]=(state.pixelKinds[input.kind]||0)+1;state.pixel++;
        }
        state.mutatedInputs++;
      }
    } finally {
      const cpu=process.cpuUsage(usage);state.cpuSeconds+=(cpu.user+cpu.system)/1e6;state.elapsedSeconds+=(performance.now()-started)/1000;checkpoint();await release();
    }
    console.log(JSON.stringify({jpeg:state.jpeg,pixel:state.pixel,uniqueInputs:state.uniqueInputs,returned:state.returnedStreams,newOracleDecodes:decodedHere,cacheHits:state.cacheHits,seconds:state.elapsedSeconds,complete:state.complete}));
    if(options['one-chunk']==='1')break;
    if(!state.complete)await new Promise(resolve=>setTimeout(resolve,100));
  }
} catch(error) {
  state.failures++;retain('failure-'+active.type+'-'+active.index,{error:String(error),stack:error.stack,sourceHash});checkpoint();throw error;
} finally {await native.close();if(rust)await rust.close();if(floatNative)await floatNative.close();for(const file of [inputsFile,streamsFile,usedFile,outcomesFile])closeSync(file);}
