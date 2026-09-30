// SPDX-License-Identifier: MIT
// Consolidate a completed, hash-bound shard receipt for a later exact-byte differential replay.
// node public/test/fuzz-cache.mjs completed-run new-cache
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

assert.equal(process.argv.length,4,'Name the completed shard run and a new cache directory');
const root=resolve(process.argv[2]),out=resolve(process.argv[3]);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const summaryBytes=readFileSync(join(root,'summary.json')),summary=JSON.parse(summaryBytes);
assert.equal(summary.complete,true,'Only a completed run supplies reusable proofs');
assert.equal(summary.failures,0,'A run with recorded failures cannot supply reusable proofs');
const proofs=new Map(),used=new Set();
const add=bytes=>{
  for(const line of bytes.toString().trim().split('\n').filter(Boolean)){
    const proof=JSON.parse(line),previous=proofs.get(proof.key);
    if(previous){
      for(const key of ['width','height','oxide','native','oxideAlpha','nativeAlpha','maximum','different'])
        assert.equal(proof[key],previous[key],'Duplicate proofs disagree: '+proof.key);
    }
    proofs.set(proof.key,proof);
  }
};
if(summary.priorEvidence){
  const bytes=readFileSync(join(summary.priorEvidence.directory,'streams.jsonl'));
  assert.equal(digest(bytes),summary.priorEvidence.sha256,'The admitted prior cache changed');add(bytes);
}
for(const receipt of summary.receipts){
  const dir=join(root,'shard-'+receipt.shard);
  for(const [file,key]of [['progress.json','progress'],['streams.jsonl','streams'],['used-streams.txt','usedStreams']]){
    const bytes=readFileSync(join(dir,file));assert.equal(digest(bytes),receipt[key],'Shard journal changed: '+file);
    if(file==='progress.json'){
      const progress=JSON.parse(bytes);assert.equal(progress.complete,true,'An incomplete shard cannot supply proofs');
      assert.equal(progress.failures,0,'A shard with recorded failures cannot supply proofs');
    }
    if(file==='streams.jsonl')add(bytes);
    if(file==='used-streams.txt')for(const hash of bytes.toString().trim().split('\n').filter(Boolean))used.add(hash);
  }
}
assert.equal(used.size,summary.uniqueReturnedStreams);
const lines=[...used].sort().map(key=>{assert.ok(proofs.has(key),'A used stream lacks its proof');return JSON.stringify(proofs.get(key));});
const bytes=Buffer.from(lines.join('\n')+(lines.length?'\n':''));
const provenance={oracles:summary.oracles,failures:0,complete:true,sourceReceipt:{directory:root,sha256:digest(summaryBytes)},
  streams:used.size,sha256:digest(bytes),note:'Exact compressed-byte proofs; exporting a cache performs no decoder executions.'};
mkdirSync(out);writeFileSync(join(out,'streams.jsonl'),bytes);writeFileSync(join(out,'progress.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify(provenance));
