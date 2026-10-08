// SPDX-License-Identifier: MIT
// One native process; each output is decoded and compared with the exact source RGBA.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {cpus,platform,arch,release} from 'node:os';
import assert from 'node:assert/strict';
const here=dirname(fileURLToPath(import.meta.url));
assert(process.argv[2], 'Use node bench/libjxl.mjs corpus.json results [efforts warmups repeats]');
const manifest=resolve(process.argv[2]);
const out=resolve(process.argv[3]||join(here,'results'));
const efforts=(process.argv[4]||'1,3,6,9').split(',').map(Number),warmups=Number(process.argv[5]??1),repeats=Number(process.argv[6]??3);
assert(efforts.every(n=>Number.isInteger(n)&&n>=1&&n<=9)&&Number.isInteger(warmups)&&warmups>=0&&Number.isInteger(repeats)&&repeats>0);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const corpus=JSON.parse(readFileSync(manifest,'utf8')).map(row=>{
 const pixels=readFileSync(resolve(dirname(manifest),row.pixels));
 assert.equal(pixels.byteLength,row.width*row.height*4);assert.equal(sha(pixels),row.rgbaHash);
 return {...row,pixels};
});
mkdirSync(out,{recursive:true});
const binary=resolve(process.env.RAPIER_LIBJXL_BENCHMARK||join(here,'libjxl'));
const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
let buffer=Buffer.alloc(0),ended=false,failure=null,notify=null,stderr='';
const wake=()=>{const callback=notify;notify=null;callback?.();};
child.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);wake();});
child.stderr.on('data',chunk=>{stderr+=chunk;});
child.once('error',error=>{failure=error;wake();});
child.stdin.on('error',error=>{failure=error;wake();});
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{ended=true;if(code!==0)failure=new Error('Native helper exited '+code+' '+signal+' '+stderr);wake();resolve({code,signal});}));
const wait=async()=>{if(failure)throw failure;if(ended)throw new Error('Native helper closed its output');await new Promise(resolve=>{notify=resolve;});};
const line=async()=>{let at;while((at=buffer.indexOf(10))<0)await wait();const value=buffer.subarray(0,at).toString('utf8');buffer=buffer.subarray(at+1);return JSON.parse(value);};
const bytes=async count=>{while(buffer.length<count)await wait();const value=buffer.subarray(0,count);buffer=buffer.subarray(count);return value;};
const send=async value=>{await new Promise((resolve,reject)=>child.stdin.write(value,error=>error?reject(error):resolve()));};
const receipt={started:new Date().toISOString(),manifest,corpusSha256:sha(readFileSync(manifest)),binarySha256:sha(readFileSync(binary)),sourceSha256:sha(readFileSync(join(here,'libjxl.cc'))),
 method:'Persistent process; fresh encoder per run; one calling thread; encode includes encoder setup, allocations and output generation. Input I/O and exact RGBA decode are outside timing. All warmup and measured outputs are decoded, including hidden RGB.',
 platform:platform(),arch:arch(),osRelease:release(),cpu:cpus()[0]?.model,node:process.version,build:JSON.parse(readFileSync(join(here,'libjxl-build.json'),'utf8')),
 affinity:readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],efforts,warmups,repeats,rows:[]};
const save=()=>writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
try {
 receipt.libjxl=await line();save();
 // Effort order rotates between images, so one level does not always receive the coldest process.
 for(let index=0;index<corpus.length;index++) {
  const item=corpus[index],order=efforts.slice(index%efforts.length).concat(efforts.slice(0,index%efforts.length));
  for(const effort of order) {
   await send(Buffer.from([item.width,item.height,effort,warmups,repeats,item.pixels.byteLength].join(' ')+'\n'));await send(item.pixels);
   const measured=await line();assert.equal(measured.ok,true);const output=await bytes(measured.bytes),file=item.id+'-e'+effort+'.jxl';
   writeFileSync(join(out,file),output);
   const row={id:item.id,kind:item.kind,width:item.width,height:item.height,rgbaHash:item.rgbaHash,effort,...measured,sha256:sha(output),output:file};
   receipt.rows.push(row);save();console.log(JSON.stringify({id:row.id,effort,bytes:row.bytes,medianMs:row.medianMs,rgbaExact:row.rgbaExact}));
  }
 }
 child.stdin.end();const exit=await exited;assert.equal(exit.code,0);receipt.outcome='pass';
} catch(error){receipt.outcome='fail';receipt.error=String(error.stack||error);throw error;}
finally {receipt.finished=new Date().toISOString();receipt.stderr=stderr;save();if(!ended)child.kill('SIGTERM');}
