// SPDX-License-Identifier: MIT
// Named, original phone metadata. Main image replacement in the upstream corpus is not a photo benchmark.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {brotliCompressSync, brotliDecompressSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {cpus} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const corpus = resolve(process.env.JXL_PHONE_CORPUS || process.argv[2] || '.'), source = process.env.JXL_SOURCE_ROOT;
if (!source) throw new Error('Set JXL_SOURCE_ROOT to the qualified codec source folder.');
const module = name => import(pathToFileURL(join(source, name + '.mjs')).href);
const {compressBrotli, decompressBrotli} = await module('brotli');
const {withMetadata, withCompressedMetadata, readMetadata, readMetadataAsync} = await module('metadata');
const {fileHeader, boxHeader, boxes, CODESTREAM, EXIF, XML, JUMBF, BROB} = await module('container');
const {encode} = await module('index');
const manifestBytes = await readFile(join(corpus, 'phone-metadata-sources.json')), manifest = JSON.parse(manifestBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), timed = process.env.JXL_PHONE_TIMING !== '0';
const prove = process.env.JXL_PHONE_PROVE !== '0', warmups = timed ? 3 : 0, sampleCount = timed ? 9 : 1;
const raw = encode(Uint8Array.of(43, 109, 171, 255), 1, 1), rows = [], allFields = [];
const concat = parts => { const out = new Uint8Array(parts.reduce((n,p) => n+p.length,0)); let at=0; for(const p of parts){out.set(p,at);at+=p.length;} return out; };
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
function exifOrientationOffset(data) {
  const little=data[0]===73, view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const first=view.getUint32(4,little), count=view.getUint16(first,little);
  for(let i=0;i<count;i++) {
    const at=first+2+i*12;
    if(view.getUint16(at,little)===274 && view.getUint16(at+2,little)===3 && view.getUint32(at+4,little)===1)
      return {at:at+8,little};
  }
  return null;
}
async function measure(work) {
  for (let i=0;i<warmups;i++) await work();
  const samples=[]; let bytes;
  for (let i=0;i<sampleCount;i++) { const start=performance.now(); bytes=await work(); samples.push(performance.now()-start); }
  return {bytes, milliseconds:timed?median(samples):null, samples:timed?samples:[]};
}
// Each existing XML packet remains separately serialized, including reassembled JPEG extended XMP.
// This composition benchmark uses the actual public metadata calls per payload, keeps their returned
// metadata boxes, and emits one shared container/codestream. It does not merge or regenerate RDF/XML.
async function carry(fields, compressed) {
  const parts=[fileHeader()];
  for (const field of fields) {
    const options={[field.kind]:field.data};
    const file=compressed ? await withCompressedMetadata(raw,{...options,compress:compressBrotli}) : withMetadata(raw,options);
    const metadata=[...boxes(file)].filter(box=>[EXIF,XML,JUMBF].includes(box.decoded));
    assert.equal(metadata.length,1);
    parts.push(file.subarray(metadata[0].at,metadata[0].end));
  }
  parts.push(boxHeader(CODESTREAM,raw.length),raw);
  return concat(parts);
}
let scratch;
if (prove) {
  if (!process.env.JXL_DJXL) throw new Error('Set JXL_DJXL for independent metadata extraction.');
  const result=spawnSync(process.env.JXL_DJXL,['--version'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr); assert.match(result.stdout+result.stderr,/0\.12\.0/);
  scratch=await mkdtemp(join(corpus,'oracle-'));
}
await mkdir(join(corpus,'encoded'),{recursive:true});
try {
  for (const row of manifest.rows) {
    const original=await readFile(join(corpus,'samples',row.name+'.jpg')); assert.equal(hash(original),row.sourceSha256,row.name+' original source');
    const fields=[];
    for (const entry of row.metadata) {
      const data=new Uint8Array(await readFile(join(corpus,entry.file))); assert.equal(hash(data),entry.sha256);
      const wire=entry.kind==='exif'?concat([new Uint8Array(4),data]):data;
      const encoded=await measure(()=>compressBrotli(wire)), decoded=await measure(()=>decompressBrotli(encoded.bytes));
      assert.deepEqual(decoded.bytes,wire); assert.deepEqual(new Uint8Array(brotliDecompressSync(encoded.bytes)),wire);
      const index=fields.length, field={...entry,data}; fields.push(field);
      const single=await withCompressedMetadata(raw,{[entry.kind]:data,compress:compressBrotli});
      const metadata=[...boxes(single)].find(box=>[EXIF,XML,JUMBF].includes(box.decoded));
      const expectedSize=Math.min(wire.length+8,encoded.bytes.length+12);
      assert.equal(metadata.end-metadata.at,expectedSize,'auto includes brob type overhead');
      const observation={name:row.name,kind:entry.kind,role:entry.role??'primary',rawPayloadBytes:data.length,serializedPayloadBytes:wire.length,
        plainBoxBytes:wire.length+8,portableBrotliBytes:encoded.bytes.length,autoBoxBytes:expectedSize,
        savedBytes:wire.length+8-expectedSize,nodeDefaultBrotliBytes:brotliCompressSync(wire).length,
        rawSha256:hash(data),serializedSha256:hash(wire),compressedSha256:hash(encoded.bytes),
        compressMs:encoded.milliseconds,decompressMs:decoded.milliseconds,compressSamples:encoded.samples,decompressSamples:decoded.samples};
      if (prove) {
        const input=join(scratch,'input.jxl'), output=join(scratch,'metadata.'+(entry.kind==='jumb'?'jumbf':entry.kind));
        await writeFile(input,single);
        const result=spawnSync(process.env.JXL_DJXL,[input,output,'--quiet'],{encoding:'utf8',timeout:30000});
        assert.equal(result.status,0,result.stderr); const extracted=new Uint8Array(await readFile(output));
        observation.djxlExtractedSha256=hash(extracted); observation.djxlRawExact=hash(extracted)===hash(data);
        await writeFile(input,withMetadata(raw,{[entry.kind]:data}));
        const plainResult=spawnSync(process.env.JXL_DJXL,[input,output,'--quiet'],{encoding:'utf8',timeout:30000});
        assert.equal(plainResult.status,0,plainResult.stderr);
        assert.deepEqual(new Uint8Array(await readFile(output)),extracted,'djxl plain and compressed metadata agree');
        observation.djxlPlainEqualsCompressed=true;
        if(!observation.djxlRawExact) {
          assert.equal(entry.kind,'exif','only Exif orientation normalization is expected');
          const orientation=exifOrientationOffset(data); assert.ok(orientation);
          const normalized=data.slice(), view=new DataView(normalized.buffer);
          observation.djxlOrientationNormalization={offset:orientation.at,sourceValue:view.getUint16(orientation.at,orientation.little),extractedValue:1,
            primarySource:'libjxl 0.12.0 lib/extras/dec/jxl.cc:639-642 and lib/extras/exif.cc:17-54'};
          view.setUint16(orientation.at,1,orientation.little);
          assert.deepEqual(extracted,normalized,'every byte other than the documented Exif orientation normalization remains exact');
        }
      }
      allFields.push(observation);
    }
    const plain=await measure(()=>carry(fields,false)), compressed=await measure(()=>carry(fields,true));
    const expected={exif:[],xmp:[],jumb:[],compressed:[]}; for(const field of fields) expected[field.kind].push(field.data);
    assert.deepEqual(readMetadata(plain.bytes),expected);
    assert.deepEqual(await readMetadataAsync(compressed.bytes,{decompress:decompressBrotli}),expected);
    assert.deepEqual(await readMetadataAsync(compressed.bytes,{decompress:data=>brotliDecompressSync(data)}),expected);
    const selected=allFields.filter(field=>field.name===row.name), plainMetadataBytes=selected.reduce((n,f)=>n+f.plainBoxBytes,0), compressedMetadataBytes=selected.reduce((n,f)=>n+f.autoBoxBytes,0);
    assert.equal(plain.bytes.length-compressed.bytes.length,plainMetadataBytes-compressedMetadataBytes);
    const observation={name:row.name,device:row.device,sourceSha256:row.sourceSha256,fields:fields.length,
      plainMetadataBytes,compressedMetadataBytes,savedBytes:plainMetadataBytes-compressedMetadataBytes,
      exifSavedBytes:selected.filter(f=>f.kind==='exif').reduce((n,f)=>n+f.savedBytes,0),
      xmpSavedBytes:selected.filter(f=>f.kind==='xmp').reduce((n,f)=>n+f.savedBytes,0),
      jumbSavedBytes:selected.filter(f=>f.kind==='jumb').reduce((n,f)=>n+f.savedBytes,0),
      plainCarrierBytes:plain.bytes.length,compressedCarrierBytes:compressed.bytes.length,
      plainCarryMs:plain.milliseconds,compressedCarryMs:compressed.milliseconds,plainSamples:plain.samples,compressedSamples:compressed.samples,
      compressedCarrierSha256:hash(compressed.bytes),plainCarrierSha256:hash(plain.bytes),
      compressedBoxes:[...boxes(compressed.bytes)].filter(box=>box.type===BROB).length};
    rows.push(observation); await writeFile(join(corpus,'encoded',row.name+'.jxl'),compressed.bytes);
    console.log(JSON.stringify({name:row.name,plain:plainMetadataBytes,compressed:compressedMetadataBytes,saved:observation.savedBytes,ms:observation.compressedCarryMs}));
  }
} finally { if(scratch) await rm(scratch,{recursive:true,force:true}); }
const sourceHashes={}; for(const name of ['brotli','metadata','container','index']) sourceHashes[name]=hash(await readFile(join(source,name+'.mjs')));
const cpuAffinity=(await readFile('/proc/self/status','utf8')).match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]??null;
const result={corpus:manifest.name,node:process.version,nodeBrotli:process.versions.brotli,libjxl:prove?'0.12.0':null,cpu:cpus()[0].model,cpuAffinity,
  benchmarkSha256:hash(await readFile(new URL(import.meta.url))),
  sourceManifestSha256:hash(manifestBytes),sourceHashes,warmups,samples:sampleCount,timing:timed,
  measurement:'Median complete public metadata attachment calls per original packet, plus collection into one shared image container, after three warmups; nine samples; source extraction, fixed image encoding and independent decode excluded; returned allocations included. Individual portable compression/decompression calls are timed separately.',
  scope:'Raw TIFF, standard and reassembled extended XMP, and JUMBF box contents only. Other JPEG APP data is recorded but excluded. XML packets are preserved separately, not RDF-merged. C2PA signature validity and source-image rendering are not evaluated. Node default Brotli sizes are a reference, not equal-effort results.',
  rows,fields:allFields};
await writeFile(process.env.JXL_PHONE_RECEIPT || join(corpus,timed?'phone-metadata-measurements.json':'phone-metadata-proof.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({complete:true,devices:rows.length,metadataPayloads:allFields.length,timed,independentExtraction:prove,
  djxlRawExact:prove?allFields.filter(field=>field.djxlRawExact).length:null,
  djxlOrientationNormalized:prove?allFields.filter(field=>field.djxlOrientationNormalization).length:null}));
