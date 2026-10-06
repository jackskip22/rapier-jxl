// SPDX-License-Identifier: MIT
// Reproducible measurements, never a timing gate. Optional audit input reads the original 131 RGBA cases
// and Grace Hopper photograph; without it, the 36 seeded artwork cases are self-contained.
import {readFileSync, existsSync} from 'node:fs';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
export function coreCases(evidence) {
  const cases = evidence ? JSON.parse(readFileSync(evidence + '/encode-results.json')).results.map(row => ({...row, data: new Uint8Array(readFileSync(evidence + '/' + row.name + '.rgba'))})) : [];
  for (const [name,width,height,kind] of [
    ['palette-ramp256',256,256,'ramp'], ['palette-ramp64',64,64,'ramp'], ['palette-checker16',128,128,'checker'],
    ['horizontal-stripes',300,257,'horizontal'], ['vertical-stripes',257,300,'vertical'], ['smooth-colour',513,259,'smooth'],
    ['alpha-edges',513,259,'alpha'], ['grey-alpha-edges',259,513,'grey-alpha'], ['noise-rgba',256,256,'noise'],
    ['grey-ramp',512,300,'grey'], ['line-art',513,259,'lines'], ['solid-rgba',257,259,'solid']]) {
    const data = new Uint8Array(width * height * 4); let seed = 1381;
    const rnd = () => (seed = (Math.imul(seed,1664525) + 1013904223) >>> 0) >>> 24;
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i += 4) {
      let r,g,b,a=255;
      if (kind === 'ramp') { r=x; g=x; b=255-x; }
      else if (kind === 'checker') { const v = (((x >> 3) + (y >> 3)) & 15); r=v*17; g=(v*37)&255; b=(v*61)&255; }
      else if (kind === 'horizontal' || kind === 'vertical') { const v = ((kind==='horizontal'? y:x) >> 2) & 255; r=v;g=(v*3)&255;b=(v*7)&255; }
      else if (kind === 'noise') { r=rnd();g=rnd();b=rnd();a=rnd(); }
      else if (kind === 'grey') { r=g=b=x&255; }
      else if (kind === 'lines') { const edge = x % 17 === 0 || y % 23 === 0; r=edge?12:255;g=edge?76:255;b=edge?93:255; }
      else if (kind === 'solid') { r=48;g=112;b=194;a=117; }
      else { r=(128+110*Math.sin(x/39))|0; g=(128+107*Math.sin(y/27))|0; b=(128+100*Math.sin((x+y)/53))|0;
        if (kind==='alpha'||kind==='grey-alpha') { a=(x*7+y*11)&255; if ((x+y)%13===0) a=0; if (kind==='grey-alpha') g=b=r; }
      }
      data.set([r,g,b,a],i);
    }
    for (const quality of [100,90,35]) cases.push({name:name+'-q'+quality,width,height,quality,data});
  }
  if (evidence) {
    const data = new Uint8Array(readFileSync(evidence+'/photo.rgba'));
    for (const quality of [100,90,35]) cases.push({name:'hopper-q'+quality,width:512,height:600,quality,data});
  }
  return cases;
}

// Run in a fresh Node process for each source. RSS is the process high-water mark, including fixture storage;
// each time is the median of three encodes, excluding fixture reads and JSON output. No decoder is timed.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const source = option('--source') || fileURLToPath(new URL(existsSync(new URL('../src/index.mjs', import.meta.url)) ? '../src/' : '../', import.meta.url));
  const {encode} = await import(pathToFileURL(resolve(source, 'index.mjs'))), cases = coreCases(option('--audit')), rows = [];
  for (const quality of [100, 90]) encode(cases[0].data, cases[0].width, cases[0].height, {quality});
  for (const c of cases) {
    const times = []; let bytes;
    for (let i = 0; i < 3; i++) { const start = performance.now(); bytes = encode(c.data, c.width, c.height, {quality: c.quality}); times.push(performance.now() - start); }
    rows.push({name: c.name, width: c.width, height: c.height, quality: c.quality, bytes: bytes.length, ms: times.sort((a, b) => a - b)[1]});
  }
  console.log(JSON.stringify({node: process.version, source, count: rows.length, bytes: rows.reduce((n, r) => n + r.bytes, 0), ms: rows.reduce((n, r) => n + r.ms, 0), peakRSSKiB: process.resourceUsage().maxRSS, rows}, null, 2));
}
