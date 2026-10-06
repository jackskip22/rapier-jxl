// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {glyphDictionary,encodePatches,patchSteps} from '../src/screen-patches.mjs';
import {screenLZ77} from '../src/screen-lz77.mjs';
import {inspectPixels} from '../src/lossless.mjs';
import {decoder} from './decoder.mjs';
const decode=await decoder();
function picture(width,height,grey,alpha){
 const rgba=new Uint8Array(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const v=x%19>=3&&x%19<10&&y%23>=5&&y%23<16?35:240;
  rgba.set([v,grey?v:(v+11)&255,grey?v:(v+19)&255,alpha?(v===35?0:128):255],(y*width+x)*4);
 }
 return rgba;
}
test('dictionary replacement reconstructs every RGBA byte without mutating its input',()=>{
 const width=513,height=300,rgba=picture(width,height,false,true),before=rgba.slice();
 const d=glyphDictionary(rgba,width,height);assert.ok(d);assert.ok(d.groups.length>0);assert.ok(d.placements>10);
 const rebuilt=d.body.slice();
 for(const g of d.groups)for(const p of g.positions)for(let y=0;y<g.h;y++)rebuilt.set(d.atlas.subarray(((g.ay+y)*d.width+g.ax)*4,((g.ay+y)*d.width+g.ax+g.w)*4),((p.y+y)*width+p.x)*4);
 assert.deepEqual(rebuilt,rgba);assert.deepEqual(rgba,before);
});
test('reference-only glyph atlases decode exactly in grey/RGB with alpha and cross-group placements', {skip:!decode},()=>{
 for(const [width,height] of [[64,64],[256,256],[257,259],[513,300]])for(const grey of [false,true])for(const alpha of [false,true]){
  const rgba=picture(width,height,grey,alpha),shape=inspectPixels(rgba,width,height);
  for(const tokenCodec of [null,screenLZ77]){
   const stats={},bytes=encodePatches(rgba,width,height,shape,undefined,{tokenCodec,stats});assert.ok(bytes);
   assert.ok(stats.atlasBytes>0&&stats.dictionaryBits>0);
   assert.deepEqual(bytes,encodePatches(rgba,width,height,shape,undefined,{tokenCodec}));
   const d=decode(bytes);assert.equal(d.width,width);assert.equal(d.height,height);
   for(let i=0;i<width*height;i++)for(let c=0;c<4;c++)assert.equal(c===3?(d.channels%2?255:d.data[i*d.channels+d.channels-1]):d.data[i*d.channels+(d.channels<3?0:c)],rgba[i*4+c]);
  }
 }
});
test('a stopped atlas never escapes as a partial visible picture',()=>{
 const width=513,height=300,rgba=picture(width,height,false,false),shape=inspectPixels(rgba,width,height);
 for(const from of [0,0.05,0.2,0.4,0.8,0.99]){
  const steps=patchSteps(rgba,width,height,shape,undefined,{tokenCodec:screenLZ77});let s,last=0,hurry=false;
  while(!(s=steps.next(hurry)).done){assert.ok(s.value>=last&&s.value<=1);last=s.value;if(last>from)hurry=true;}
  assert.equal(s.value,null);
 }
 assert.equal(glyphDictionary(new Uint8Array(4),1,1),null);
});
