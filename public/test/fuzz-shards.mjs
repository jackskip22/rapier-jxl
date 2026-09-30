// SPDX-License-Identifier: MIT
// Disjoint deterministic index ranges. A coordinator holds one benchmark lease while its
// workers run a bounded chunk; only completed ranges are merged into the final receipt.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const options={},args=process.argv.slice(2);
for(let i=0;i<args.length;i+=2){assert.ok(['--out','--jpegs','--pixels','--seed','--workers','--lock','--reuse','--against'].includes(args[i])&&args[i+1],'Unknown argument '+args[i]);options[args[i].slice(2)]=args[i+1];}
const integer=(key,value)=>{const result=Number(options[key]??value);assert.ok(Number.isSafeInteger(result)&&result>=0,'Invalid '+key);return result;};
const workers=integer('workers',1),jpegs=integer('jpegs',2000000),pixels=integer('pixels',32768),seed=integer('seed',20260930);
assert.ok(workers>=1&&workers<=8,'Choose from one to eight workers');
const root=resolve(options.out||'fuzz-shards');mkdirSync(root,{recursive:true});
const plan={seed,jpegs,pixels,workers,reuse:options.reuse?resolve(options.reuse):null,against:options.against?resolve(options.against):null,
  ranges:Array.from({length:workers},(_,i)=>({jpegStart:Math.floor(jpegs*i/workers),jpegEnd:Math.floor(jpegs*(i+1)/workers),pixelStart:Math.floor(pixels*i/workers),pixelEnd:Math.floor(pixels*(i+1)/workers)}))};
if(existsSync(join(root,'plan.json')))assert.deepEqual(JSON.parse(readFileSync(join(root,'plan.json'),'utf8')),plan,'Resume the same index partition');
else writeFileSync(join(root,'plan.json'),JSON.stringify(plan,null,2)+'\n');
const read=(path)=>JSON.parse(readFileSync(path,'utf8'));
const progress=i=>existsSync(join(root,'shard-'+i,'progress.json'))?read(join(root,'shard-'+i,'progress.json')):null;
const run=(command,args,stdio)=>new Promise((accept,reject)=>{const child=spawn(command,args,{stdio});child.once('error',reject);child.once('exit',(code,signal)=>code===0?accept():reject(new Error('Fuzz worker failed: '+(code??signal))));});
async function acquire(){
  if(!options.lock)return async()=>{};
  const child=spawn('flock',['-x',resolve(options.lock),'sh','-c','printf "locked\\n"; cat >/dev/null'],{stdio:['pipe','pipe','inherit']});
  await new Promise((accept,reject)=>{child.once('error',reject);child.stdout.once('data',accept);child.once('exit',code=>{if(code)reject(new Error('Lock failed'));});});
  return ()=>new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',code=>code?reject(new Error('Unlock failed')):accept());child.stdin.end();});
}
const previousWall=existsSync(join(root,'summary.json'))?read(join(root,'summary.json')).wallSeconds:0;
const began=Date.now();let maximumLeaseSeconds=existsSync(join(root,'coordinator.json'))?read(join(root,'coordinator.json')).maximumLeaseSeconds:0;
while(plan.ranges.some((_,i)=>!progress(i)?.complete)){
  const release=await acquire(),started=performance.now();
  try{
    const results=await Promise.allSettled(plan.ranges.map((range,i)=>{
      if(progress(i)?.complete)return;
      const argv=[fileURLToPath(new URL('./fuzz-scale.mjs',import.meta.url)),'--out',join(root,'shard-'+i),'--seed',String(seed),
        '--jpeg-start',String(range.jpegStart),'--jpegs',String(range.jpegEnd),'--pixel-start',String(range.pixelStart),'--pixels',String(range.pixelEnd),'--seconds','20','--one-chunk','1'];
      if(plan.reuse)argv.push('--reuse',plan.reuse);if(plan.against)argv.push('--against',plan.against);
      return run(process.execPath,argv,['ignore','inherit','inherit']);
    }));
    for(const result of results)if(result.status==='rejected')throw result.reason;
  }finally{maximumLeaseSeconds=Math.max(maximumLeaseSeconds,(performance.now()-started)/1000);await release();writeFileSync(join(root,'coordinator.json'),JSON.stringify({maximumLeaseSeconds})+'\n');}
  const counts=plan.ranges.map((_,i)=>progress(i));console.log(JSON.stringify({verifiedMutations:counts.reduce((n,p)=>n+(p?.mutatedInputs||0),0),maximumLeaseSeconds}));
  await new Promise(resolve=>setTimeout(resolve,100));
}
const inputs=new Set(),used=new Set(),newProofs=new Map(),outcomes=new Map();
const summary={plan,complete:true,failures:0,mutatedInputs:0,returnedStreams:0,cacheHits:0,decoderExecutions:{oxide:0,native:0,jxlRs:0},floatDecoderExecutions:0,refusals:{},paths:{},comparison:{identical:0,changed:0,refusalChanges:0},differences:{},jxlRsDifferences:{},receipts:[],maximumLeaseSeconds,wallSeconds:Math.max(previousWall,(Date.now()-began)/1000)};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
for(let i=0;i<workers;i++){
  const dir=join(root,'shard-'+i),p=progress(i),range=plan.ranges[i];
  assert.deepEqual(p.oracles,progress(0).oracles,'Every shard uses identical decoder identities and optional availability');
  assert.equal(p.complete,true,'An incomplete shard cannot supply a successful receipt');
  assert.equal(p.failures,0,'A shard with recorded failures cannot supply a successful receipt');summary.failures+=p.failures;
  assert.equal(p.jpeg,range.jpegEnd);assert.equal(p.pixel,range.pixelEnd);assert.equal(p.mutatedInputs,range.jpegEnd-range.jpegStart+range.pixelEnd-range.pixelStart);
  assert.equal(p.returnedStreams,p.cacheHits+p.uniqueOracleDecodes.oxide,'Every stream is newly decoded or uses earlier exact-byte evidence');
  for(const key of ['mutatedInputs','returnedStreams','cacheHits'])summary[key]+=p[key];
  for(const key of ['refusals','paths','comparison'])for(const [name,value]of Object.entries(p[key]))summary[key][name]=(summary[key][name]||0)+value;
  for(const oracle of ['oxide','native','jxlRs'])summary.decoderExecutions[oracle]+=p.uniqueOracleDecodes[oracle];
  summary.floatDecoderExecutions+=p.floatDecoderExecutions;
  for(const value of readFileSync(join(dir,'inputs.txt'),'utf8').trim().split('\n').filter(Boolean))inputs.add(value);
  for(const value of readFileSync(join(dir,'used-streams.txt'),'utf8').trim().split('\n').filter(Boolean))used.add(value);
  for(const line of readFileSync(join(dir,'streams.jsonl'),'utf8').trim().split('\n').filter(Boolean)){
    const proof=JSON.parse(line),previous=newProofs.get(proof.key);if(previous){assert.equal(previous.oxide,proof.oxide);assert.equal(previous.native,proof.native);assert.equal(previous.jxlRs,proof.jxlRs);}else newProofs.set(proof.key,proof);
  }
  for(const line of readFileSync(join(dir,'outcomes.jsonl'),'utf8').trim().split('\n').filter(Boolean)){
    const row=JSON.parse(line),previous=outcomes.get(row.input);if(previous)assert.deepEqual(previous,row,'Overlapping input bytes have identical outcomes');else outcomes.set(row.input,row);
  }
  summary.receipts.push({shard:i,progress:hashFile('progress.json'),inputs:hashFile('inputs.txt'),outcomes:hashFile('outcomes.jsonl'),streams:hashFile('streams.jsonl'),usedStreams:hashFile('used-streams.txt')});
  function hashFile(name){return digest(readFileSync(join(dir,name)));}
}
assert.equal(summary.mutatedInputs,jpegs+pixels);summary.uniqueInputs=inputs.size;summary.uniqueReturnedStreams=used.size;
summary.uniqueNewlyDecodedStreams=newProofs.size;summary.duplicateDecoderExecutions=summary.decoderExecutions.oxide-newProofs.size;
summary.priorEvidence=progress(0).initialEvidence;summary.oracles=progress(0).oracles;summary.sources=progress(0).sources;summary.against=progress(0).against;
summary.jxlRsUnavailable=progress(0).jxlRsUnavailable;
const allProofs=new Map(newProofs);
if(plan.reuse)for(const line of readFileSync(join(plan.reuse,'streams.jsonl'),'utf8').trim().split('\n').filter(Boolean)){const row=JSON.parse(line);if(!allProofs.has(row.key))allProofs.set(row.key,row);}
for(const key of used){
  const proof=allProofs.get(key);assert.ok(proof,'Every used stream has an exact-byte proof');
  if(summary.oracles.jxlRs){
    assert.ok(proof.jxlRs,'Every used stream has configured jxl-rs proof');
    for(const [name,value]of Object.entries(proof.jxlRsDifferences)){
      const group=summary.jxlRsDifferences[name]||={differingStreams:0,rgb:0,alpha:0,maximum:0};
      group.differingStreams+=Number(value.rgb>0||value.alpha>0);group.rgb+=value.rgb;group.alpha+=value.alpha;group.maximum=Math.max(group.maximum,value.maximum);
    }
  }
  if(proof.different){
    const kind=proof.firstInput?.type==='pixels'?'photo':'jpeg',name=kind+':'+proof.maximum;
    const row=summary.differences[name]||={uniqueStreams:0,channels:[0,0,0,0],maximum:proof.maximum,integerTie:0,reconstruction:0,representativeStream:key};
    row.uniqueStreams++;proof.channels.forEach((n,c)=>row.channels[c]+=n);
    assert.ok(proof.rounding,'Every nonzero difference has native floating-output evidence');
    row.integerTie+=proof.rounding.integerTie;row.reconstruction+=proof.rounding.reconstruction;
  }
}
summary.harness=progress(0).harness;summary.grammar=progress(0).grammar;summary.seedFiles=progress(0).seedFiles;
for(let i=1;i<workers;i++){assert.deepEqual(progress(i).oracles,summary.oracles);assert.deepEqual(progress(i).sources.map(s=>s.sha256),summary.sources.map(s=>s.sha256));assert.deepEqual(progress(i).against,summary.against);}
writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
