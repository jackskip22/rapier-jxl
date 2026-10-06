// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {screenResiduals,screenMatches,screenLZ77,screenModel} from '../src/screen-lz77.mjs';
import {encodeScreen} from '../src/screen.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {decoder} from './decoder.mjs';
const decode=await decoder();
test('screen LZ77 round-trips nonzero runs, repeated rows, overlap and far distances',()=>{
 const streams=[new Uint32Array(65536).fill(913),Uint32Array.from({length:65536},(_,i)=>i%257),Uint32Array.from({length:65536},(_,i)=>((i%4096)*813)&511)];
 let random=991;streams.push(Uint32Array.from({length:8192},()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random>>>16;}));
 for(const input of streams){
  const out=[],tokens=[];
  screenMatches(input,(v,n,d)=>{tokens.push([v,n,d]);if(n){assert.ok(d>0&&d<=out.length);for(let i=0;i<n;i++)out.push(out[out.length-d]);}else out.push(v);});
  assert.deepEqual(Uint32Array.from(out),input);
  const again=[];screenMatches(input,(...t)=>again.push(t));assert.deepEqual(tokens,again);
 }
});
test('screen residual boundaries agree with the modular predictors',()=>{
 const p=Int16Array.of(3,7,10,13);
 assert.deepEqual([...screenResiduals(p,2,2,0)],[6,14,20,26]);
 assert.deepEqual([...screenResiduals(p,2,2,1)],[6,8,14,6]);
 assert.deepEqual([...screenResiduals(p,2,2,2)],[6,8,14,12]);
 assert.throws(()=>screenResiduals(p,2,2,6),/predictor/);
});
test('the screen model keeps a nearer equally long copy after a repeated row hint',()=>{
 const pattern=Array.from({length:16},(_,i)=>i+1),values=[...pattern,...Array.from({length:8},(_,i)=>i+21),...pattern,...Array.from({length:8},(_,i)=>i+31),...pattern,...Array.from({length:16},(_,i)=>i+41)];
 const plane=Int16Array.from(values,v=>v&1?-(v+1)/2:v/2),model=screenModel(plane,16,5),out=[],copies=[];
 for(let i=0;i<model.pieces.length;i+=2){
  const value=model.pieces[i],distance=model.pieces[i+1];
  if(distance){const length=value+7;copies.push({at:out.length,length,distance});for(let n=0;n<length;n++)out.push(out[out.length-distance]);}
  else out.push(value);
 }
 assert.deepEqual(Uint32Array.from(out),screenResiduals(plane,16,5,model.leaf.predictor));
 assert.deepEqual(copies.find(copy=>copy.at===48),{at:48,length:16,distance:24});
});
test('LZ77 screen candidates decode exactly across groups and channel layouts', {skip:!decode},()=>{
 for(const [width,height] of [[1,1],[1,513],[513,1],[256,256],[257,259],[600,33]])for(const grey of [false,true])for(const alpha of [false,true]){
  const rgba=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const v=(x%13<4&&y%17<9)?29:240;rgba.set([v,grey?v:(v+11)&255,grey?v:(v+23)&255,alpha?((x+y)%23?128:0):255],(y*width+x)*4);
  }
  const shape=inspectPixels(rgba,width,height);
  for(const mode of ['global','scalar','direct']){
   const bytes=encodeScreen(rgba,width,height,shape,undefined,{mode,tokenCodec:screenLZ77});if(!bytes)continue;
   const d=decode(bytes);assert.equal(d.width,width);assert.equal(d.height,height);
   for(let i=0;i<width*height;i++)for(let c=0;c<4;c++)assert.equal(c===3?(d.channels%2?255:d.data[i*d.channels+d.channels-1]):d.data[i*d.channels+(d.channels<3?0:c)],rgba[i*4+c]);
  }
 }
});
