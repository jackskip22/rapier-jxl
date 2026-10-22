// SPDX-License-Identifier: MIT
// An 8.39MP memory-bounded witness: an exact candidate above the former16MiB ceiling survives hurry unchanged.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {encodeDeltaPalette} from '../src/delta-palette.mjs';
import {encodeGraphicsSteps} from '../src/graphics.mjs';
import {decoder} from '../test/decoder.mjs';
import {djxlDecoder} from '../test/djxl-decoder.mjs';
import {rgbaOf} from '../test/oracles.mjs';
import {graphicsWitness,graphicsNativeRgba} from '../test/graphics-cases.mjs';
const width=4096,height=2048,rgba=new Uint8Array(width*height*4),hash=x=>createHash('sha256').update(x).digest('hex');
let seed=0x4531abc;
for(let p=0;p<rgba.length;p+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;rgba.set([seed&63,(seed>>>8)&63,(seed>>>16)&63,255],p);}
const exact={screenEffort:1,deltaPredictor:'left',maxPaletteColors:1};
const exactBytes=encodeDeltaPalette(rgba,width,height,exact);
assert.ok(exactBytes.length>16777216,'the exact fixture crosses the former16MiB ceiling');
console.log('Complete exact candidate',exactBytes.length);
const options={...exact,maxColorError:32,preserveEdges:false,undither:true},steps=encodeGraphicsSteps(rgba,width,height,options);steps.hurry=true;
for(const progress of steps)assert.ok(progress>=0&&progress<=1);
const bytes=steps.bytes;assert.deepEqual(bytes,exactBytes,'hurry retains the complete exact candidate without a byte ceiling');console.log('Hurried exact output',bytes.length);
const native=await djxlDecoder({timeout:120000}),oxide=await decoder();assert.ok(native&&oxide);
try{
 const lib=graphicsNativeRgba(await native.decode(bytes,width,height)),ox=rgbaOf(oxide(bytes));assert.deepEqual(lib,ox);assert.deepEqual(lib,rgba);
 const witness=graphicsWitness(rgba,lib,width,height,options);assert.ok(witness.maxColorError<=32);
 assert.equal(witness.alphaErrors,0);assert.equal(witness.hiddenErrors,0);
 const report={width,height,seed:'0x4531abc',sourceSha256:hash(rgba),formerCeiling:16777216,exactBytes:exactBytes.length,options,hurry:true,bytes:bytes.length,sha256:hash(bytes),witness,oxide:oxide.version,djxl:native.version};
 await writeFile(process.argv[2] || 'graphics-limit-results.json',JSON.stringify(report,null,2)+'\n');console.log(report);
}finally{await native.close();}
