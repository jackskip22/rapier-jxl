// SPDX-License-Identifier: MIT
// Reproduce and explain a retained decoder disagreement from the actual codestream. Floating-point
// samples are evidence about decoder arithmetic, never substituted for exact lossless/alpha checks.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {encode} from '../src/index.mjs';
import {transcode} from '../src/jpeg.mjs';
import {encodePhoto} from '../src/photo.mjs';
import {decoder} from './decoder.mjs';
import {rgbaOf} from './oracles.mjs';
import {nativeDecoder} from './native-decoder.mjs';
import {scaleJPEG,pixelCase} from './fuzz-cases.mjs';
const metadata=resolve(process.argv[2]||fileURLToPath(new URL('./seeds/decoder-difference.json',import.meta.url)));
const document=JSON.parse(readFileSync(metadata,'utf8')),item=document.rows?document.rows.find(row=>row.stream===process.argv[3]):document;
if(!item)throw new Error('Name a retained stream hash from the diagnostic receipt');
const stem=metadata.replace(/\.json$/,'');
let input;
if(item.generated){
  input=item.type==='jpeg'?scaleJPEG(new Uint8Array(readFileSync(new URL('./seeds/'+item.source,import.meta.url))),item.seed,item.index).bytes:
    pixelCase(item.seed,item.index,{compact:item.index%256!==0}).rgba;
}else input=readFileSync(item.file?join(dirname(metadata),item.file):stem+(item.type==='jpeg'?'.jpg':'.rgba'));
let bytes,width,height;
if(existsSync(stem+'.jxl')){bytes=new Uint8Array(readFileSync(stem+'.jxl'));({width,height}=item.entry);}
else if(item.type==='jpeg')({bytes,width,height}=transcode(new Uint8Array(input)));
else {({width,height}=item);bytes=(item.path==='photo'?encodePhoto:encode)(new Uint8Array(input),width,height,{quality:item.quality});}
if(item.stream&&createHash('sha256').update(bytes).digest('hex')!==item.stream)throw new Error('The reproduction no longer encodes the retained stream bytes');
const oxide=await decoder(),native=await nativeDecoder(),float=await nativeDecoder({float:true});
try{
  const a=rgbaOf(oxide(bytes)),b=await native.decode(bytes,width,height),samples=await float.decode(bytes,width,height),differences=[];
  const even=x=>{const base=Math.floor(x),part=x-base;return part===0.5?base+(base%2):Math.round(x);};
  for(let i=0;i<a.length;i++)if(a[i]!==b[i]){
    const scaled=Math.fround(samples[i]*255),halfUp=Math.max(0,Math.min(255,Math.trunc(Math.fround(scaled+0.5)))),nearestEven=Math.max(0,Math.min(255,even(scaled)));
    differences.push({x:Math.floor(i/4)%width,y:Math.floor(i/(4*width)),channel:'RGBA'[i%4],oxide:a[i],native:b[i],nativeFloat:samples[i],scaledFloat32:scaled,
      halfUp,nearestEven,classification:halfUp===a[i]&&nearestEven===b[i]?'integer-rounding-rule':'floating-reconstruction-rounding'});
  }
  console.log(JSON.stringify({inputSha256:createHash('sha256').update(input).digest('hex'),streamSha256:createHash('sha256').update(bytes).digest('hex'),width,height,
    oracles:{oxide:oxide.version,native:native.version},differences,
    primarySources:{oxide:'https://github.com/tirr-c/jxl-oxide/blob/0.12.6/crates/jxl-oxide/src/fb.rs#L537-L568',native:'https://github.com/libjxl/libjxl/blob/v0.7.0/lib/jxl/render_pipeline/stage_write.cc#L113-L133'}},null,2));
}finally{await native.close();await float.close();}
