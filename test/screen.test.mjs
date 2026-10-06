// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encode,encodeSteps} from '../src/effort.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {encodeScreen,screenPlan,screenLike} from '../src/screen.mjs';
import {screenEligible} from '../src/screen-search.mjs';
import {decoder} from './decoder.mjs';
const decode=await decoder();
export function screenFixture(width=257,height=259,alpha=false){
 const rgba=new Uint8Array(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const ink=x%19>=3&&x%19<10&&y%23>=5&&y%23<16,v=ink?40:240,i=(y*width+x)*4;
  rgba.set([v,ink?60:240,ink?80:240,alpha?(ink?0:200):255],i);
 }
 return {rgba,width,height};
}
function exact(bytes,p){
 const d=decode(bytes);assert.equal(d.width,p.width);assert.equal(d.height,p.height);
 for(let i=0;i<p.width*p.height;i++)for(let c=0;c<4;c++){
  const value=c===3?(d.channels%2===0?d.data[i*d.channels+d.channels-1]:255):d.data[i*d.channels+(d.channels<3?0:c)];
  assert.equal(value,p.rgba[4*i+c],'pixel '+i+' channel '+c);
 }
}
test('screen route rejects textured inputs without changing their palette limit',()=>{
 const p=screenFixture();assert.equal(screenLike(p.rgba,p.width,p.height),true);
 assert.equal(screenEligible(p.rgba,p.width,p.height,{palette:null}),false);
 const noise=new Uint8Array(128*128*4);let state=17;
 for(let i=0;i<noise.length;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;noise[i]=state>>>24;}
 assert.equal(screenLike(noise,128,128),false);
 assert.equal(screenLike(p.rgba,1,1),false);
});
test('global and scalar screen transforms decode exactly, including hidden RGB', {skip:!decode},()=>{
 for(const alpha of [false,true])for(const [width,height] of [[31,47],[256,256],[257,259],[600,33]]){
  const p=screenFixture(width,height,alpha),shape=inspectPixels(p.rgba,width,height);
  for(const mode of ['global','scalar','direct']){
   const bytes=encodeScreen(p.rgba,width,height,shape,undefined,{mode});if(!bytes)continue;
   exact(bytes,p);assert.deepEqual(bytes,encodeScreen(p.rgba,width,height,shape,undefined,{mode}));
  }
 }
 const p=screenFixture(1025,259,true),shape=inspectPixels(p.rgba,p.width,p.height);
 for(const mode of ['global','frequency','scalar','direct']){
  const bytes=encodeScreen(p.rgba,p.width,p.height,shape,undefined,{mode,search:{}});if(bytes)exact(bytes,p);
 }
});
test('palette planning has a fixed bound and preserves actual zero colour',()=>{
 const p=screenFixture(64,64,true);p.rgba.fill(0,0,4);
 const shape=inspectPixels(p.rgba,p.width,p.height),plan=screenPlan(p.rgba,p.width,p.height,shape,'global');
 assert.equal(plan.meta[0].width,3);
 const rgba=new Uint8Array(4097*4);for(let i=0;i<4097;i++){rgba[i*4]=i&255;rgba[i*4+1]=i>>8;rgba[i*4+3]=255;}
 assert.equal(screenPlan(rgba,4097,1,{channels:3,colour:3,alpha:false},'global'),null);
});
test('screen effort preserves effort 1, progresses monotonically and keeps an exact hurry floor', {skip:!decode},()=>{
 const p=screenFixture(),first=encode(p.rgba,p.width,p.height,{effort:1});
 for(const effort of [3,4,6]){
  const full=encode(p.rgba,p.width,p.height,{effort});assert.ok(full.length<=first.length);exact(full,p);
  for(const from of [0,0.49,0.7,0.95]){
   const job=encodeSteps(p.rgba,p.width,p.height,{effort});let previous=0;
   for(const progress of job){assert.ok(progress>=previous&&progress<=1);previous=progress;if(progress>from)job.hurry=true;}
   assert.equal(previous,1);assert.ok(job.bytes.length<=first.length);exact(job.bytes,p);
   if(from===0)assert.deepEqual(job.bytes,first);
  }
 }
});

test('effort 3 stops a large screen win while higher efforts keep the broader search', {skip:!decode},()=>{
 const p=screenFixture(513,300),floor=encode(p.rgba,p.width,p.height,{effort:1});
 const steps=[];
 for(const effort of [3,4]){let count=0;const j=encodeSteps(p.rgba,p.width,p.height,{effort});for(const progress of j){count++;assert.ok(progress>=0&&progress<=1);}steps.push(count);assert.ok(j.bytes.length<=floor.length);exact(j.bytes,p);}
 assert.ok(steps[0]<steps[1], 'effort 3 must skip redundant searches after a strong win');
});

test('higher screen effort keeps repeated pixels across group boundaries with fewer exact bytes', {skip:!decode},()=>{
 for(const banner of [false,true]){
  const p=screenFixture(513,300,true);
  if(banner)for(let y=0;y<32;y++)for(let x=0;x<p.width;x++)p.rgba.set([x&255,((x>>8)*64+y)&255,211,255],(y*p.width+x)*4);
  const before=p.rgba.slice(),floor=encode(p.rgba,p.width,p.height,{effort:4});
  for(const effort of [5,9]){
   const bytes=encode(p.rgba,p.width,p.height,{effort});
   assert.ok(bytes.length<floor.length, `deeper screen effort ${effort}, banner ${banner}: ${bytes.length} must improve ${floor.length} bytes`);
   exact(bytes,p);assert.deepEqual(bytes,encode(p.rgba,p.width,p.height,{effort}));
  }
  assert.deepEqual(p.rgba,before);
 }
});
