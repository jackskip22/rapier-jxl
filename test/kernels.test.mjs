// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {encode, encodeSteps} from '../src/effort.mjs';
import {BitWriter} from '../src/bits.mjs';
import {buildCode, uintConfig} from '../src/prefix.mjs';
import {codeChannel, leaf} from '../src/modular.mjs';
import {codeWeighted} from '../src/weighted.mjs';
import {configureKernels, kernelMode} from '../src/kernels.mjs';
import {kernelHooks} from '../src/kernel-hooks.mjs';
import {SCALAR, SIMD, SIMD_PROBE} from '../src/kernels-bytes.mjs';
import {coreCases} from '../bench/core.mjs';

const modes = ['off', 'scalar', 'simd'];
const supportsSIMD = typeof WebAssembly === 'object' && WebAssembly.validate(Uint8Array.from(atob(SIMD_PROBE), c => c.charCodeAt(0)));
const use = mode => assert.equal(configureKernels(mode), mode, 'backend actually runs');
let seed = 173;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };

test('kernel configuration rejects invalid input with a stable code and keeps the active backend', () => {
  const active = configureKernels('auto');
  try {
    for (const mode of ['unknown', null, 42, Symbol('mode')]) {
      assert.throws(() => configureKernels(mode), {code: 'JXL_INPUT'});
      assert.equal(kernelMode(), active);
    }
  } finally { configureKernels('off'); }
});

// Never let an absent feature silently turn an acceleration comparison into JS-vs-JS.
test('the accelerated entry keeps its configuration through package tree shaking', () => {
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
  assert.ok(Array.isArray(manifest.sideEffects));
  assert.ok(manifest.sideEffects.some(file => file.endsWith('/wasm.mjs')));
  assert.ok(manifest.sideEffects.some(file => file.endsWith('/wasm.min.mjs')));
});

test('generated modules validate and import only private memory', {skip: !supportsSIMD}, () => {
  for (const bytes of [SCALAR, SIMD]) {
    const m = new WebAssembly.Module(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)));
    assert.deepEqual(WebAssembly.Module.imports(m), [{module:'env',name:'memory',kind:'memory'}]);
  }
});

test('scalar and SIMD predictors, histograms and bits match signed JS at boundaries', {skip: !supportsSIMD}, () => {
  for (const [width,height] of [[1,1],[1,17],[17,1],[2,3],[3,5],[5,3],[8,17],[31,33],[256,256]]) {
    for (const pattern of ['random','full-int16','constant','zeros','ramp']) {
      const n=width*height, plane=Int16Array.from({length:n},(_,i) => pattern==='random'?(random()%511)-255 : pattern==='full-int16'?(random()&65535)-32768 : pattern==='constant'?-7 : pattern==='zeros'?0 : (i/width|0)-(i%width/3|0));
      for (let predictor=0;predictor<7;predictor++) {
        const results=[];
        for (const mode of modes) {
          use(mode);
          const histogram=new Uint32Array(257), residuals=new Uint32Array(n), properties=new Int32Array(n), chosen=leaf(predictor,-3);
          if(predictor===6) {
            codeWeighted(null,null,plane,width,height,-3,undefined,residuals,properties);
            codeWeighted(null,[histogram],plane,width,height,-3);
          } else codeChannel(null,histogram,plane,width,height,chosen);
          const code=buildCode(histogram), writer=new BitWriter(16);writer.write(7,93);
          if(predictor===6)codeWeighted(writer,[code],plane,width,height,-3);else codeChannel(writer,code,plane,width,height,chosen);
          results.push({histogram,residuals,properties,bits:writer.finish(),bitLength:writer.bitLength});
        }
        for(const result of results.slice(1))assert.deepEqual(result,results[0],`${width}x${height}/${pattern}/p${predictor}`);
      }
    }
  }
  use('off');
});

test('raw histograms and every hybrid-integer configuration of the lossless coder match the JavaScript', {skip: !supportsSIMD}, () => {
  // The calls the kernels took and the calls they declined, by backend: a comparison of JavaScript with itself proves nothing.
  const tallies = {scalar: {took: 0, declined: 0}, simd: {took: 0, declined: 0}};
  const watched = mode => {
    use(mode);
    if (mode === 'off') return;
    const real = kernelHooks.channel, tally = tallies[mode];
    kernelHooks.channel = (...call) => { const took = real(...call); tally[took ? 'took' : 'declined']++; return took; };
  };
  const configs = [uintConfig(0), uintConfig(4), uintConfig(4, 1, 1), uintConfig(3, 0, 1), uintConfig(5, 1, 2), uintConfig(2, 2, 0), uintConfig(6)];
  const shapes = [[1, 1], [1, 9], [9, 1], [7, 5], [33, 17], [64, 64], [256, 256]];
  for (const [width, height] of shapes) {
    for (const pattern of ['random', 'full-int16', 'powers', 'constant', 'zeros', 'ramp', 'stripes']) {
      const n = width * height, plane = Int16Array.from({length: n}, (_, i) => pattern === 'random' ? (random() % 511) - 255 : pattern === 'full-int16' ? (random() & 65535) - 32768
        : pattern === 'powers' ? ((i & 1 ? -1 : 1) * ((1 << (i % 15)) + (i % 3) - 1)) : pattern === 'constant' ? -7 : pattern === 'zeros' ? 0 : pattern === 'ramp' ? (i / width | 0) - (i % width / 3 | 0) : ((i / 40 | 0) & 1) * 90);
      for (const predictor of [0, 1, 2, 3, 4, 5]) for (const bins of [1057, 4129]) {
        const results = [];
        for (const mode of modes) {
          watched(mode);
          const raw = new Uint32Array(bins);
          codeChannel(null, raw, plane, width, height, leaf(predictor, 0), true);
          results.push(raw);
        }
        assert.deepEqual(results[1], results[0], `raw ${width}x${height}/${pattern}/p${predictor}/${bins}`);
        assert.deepEqual(results[2], results[0], `raw ${width}x${height}/${pattern}/p${predictor}/${bins}`);
      }
      for (const predictor of [1, 3, 5]) for (const config of configs) {
        // The tokens counted under the configuration, then written through the code they price.
        const chosen = Object.assign(leaf(predictor, 0), {config}), results = [];
        use('off');
        const counted = new Uint32Array(257);
        codeChannel(null, counted, plane, width, height, chosen);
        const code = buildCode(counted);
        for (const mode of modes) {
          watched(mode);
          const histogram = new Uint32Array(257), writer = new BitWriter(16);
          writer.write(5, 21);
          codeChannel(null, histogram, plane, width, height, chosen);
          codeChannel(writer, code, plane, width, height, chosen);
          results.push({histogram, bytes: writer.finish(), bitLength: writer.bitLength});
        }
        assert.deepEqual(results[1], results[0], `config ${JSON.stringify(config)} ${width}x${height}/${pattern}/p${predictor}`);
        assert.deepEqual(results[2], results[0], `config ${JSON.stringify(config)} ${width}x${height}/${pattern}/p${predictor}`);
      }
    }
  }
  use('off');
  for (const mode of ['scalar', 'simd']) { assert.equal(tallies[mode].declined, 0, mode + ' declined a call it should take'); assert.ok(tallies[mode].took > 2000, mode + ' took ' + tallies[mode].took + ' calls'); }
});

test('large learned groups keep exact weighted residuals and properties through arena growth', {skip: !supportsSIMD}, () => {
  try {
    for (const [width, height] of [[257, 256], [512, 600], [1024, 1024], [16384, 64], [1, 65537], [256, 256]]) {
      for (const pattern of ['random', 'full-int16', 'zeros']) {
        const n = width * height, plane = Int16Array.from({length: n}, () => pattern === 'random'
          ? (random() % 511) - 255 : pattern === 'full-int16' ? (random() & 65535) - 32768 : 0);
        let expected;
        for (const mode of modes) {
          use(mode);
          let accepted = 0;
          if (mode !== 'off') {
            const weighted = kernelHooks.weighted;
            kernelHooks.weighted = (...args) => { const took = weighted(...args); accepted += took; return took; };
          }
          const residuals = new Uint32Array(n), properties = new Int32Array(n);
          codeWeighted(null, null, plane, width, height, -3, undefined, residuals, properties);
          if (mode === 'off') expected = {residuals, properties};
          else {
            assert.equal(accepted, 1, mode + ' must execute its weighted kernel');
            for (const [name, actual] of Object.entries({residuals, properties})) {
              const wanted = expected[name];
              assert.ok(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
                .equals(Buffer.from(wanted.buffer, wanted.byteOffset, wanted.byteLength)),
                `${width}x${height}/${pattern}/${mode}/${name}`);
            }
          }
        }
      }
    }
  } finally { use('off'); }
});

test('zero-run thresholds and copies keep pixel contexts and every pending bit position', {skip: !supportsSIMD}, () => {
  const identity=Int32Array.from({length:34},(_,i)=>i);
  for(const n of [1,7,8,9,15,16,17,23,24,25,39,40,71,72,1031,65536]) {
    const plane=new Int16Array(n); if(n>9) {plane[0]=13;plane[n-1]=-11;}
    for(const pending of [0,1,2,3,4,5,6,7]) {
      const results=[];
      for(const mode of modes) {
        use(mode);const targets=Array.from({length:34},()=>new Uint32Array(257));
        const width=n===65536?256:n,height=n===65536?256:1;
        codeWeighted(null,targets,plane,width,height,0,identity);
        const writer=new BitWriter(1);writer.write(pending,2**pending-1);
        codeWeighted(writer,targets.map(buildCode),plane,width,height,0,identity);
        results.push({targets,bytes:writer.finish(),bitLength:writer.bitLength});
      }
      assert.deepEqual(results[1],results[0]);assert.deepEqual(results[2],results[0]);
    }
  }
  use('off');
});

test('RGBA conversion matches each channel shape, odd tails and rectangle strides', {skip: !supportsSIMD}, () => {
  const imageWidth=37, imageHeight=19, rgba=Uint8Array.from({length:imageWidth*imageHeight*4},()=>random()&255);
  for(const [x0,y0,w,h]of [[0,0,1,1],[2,3,7,9],[3,4,31,15],[0,0,37,19]])for(const channels of [1,2,3,4]) {
    const expected=Array.from({length:channels},()=>new Int16Array(w*h));
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const at=y*w+x,i=((y0+y)*imageWidth+x0+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2],co=r-b,tmp=b+(co>>1),cg=g-tmp;
      if(channels>=3){expected[0][at]=tmp+(cg>>1);expected[1][at]=co;expected[2][at]=cg;if(channels===4)expected[3][at]=rgba[i+3];}
      else{expected[0][at]=r;if(channels===2)expected[1][at]=rgba[i+3];}
    }
    for(const mode of modes.slice(1)) {use(mode);const planes=expected.map(p=>new Int16Array(p.length));assert.equal(kernelHooks.fill(rgba,imageWidth,x0,y0,w,h,channels,planes),true);assert.deepEqual(planes,expected);}
  }
  use('off');
});

test('corpus efforts 1, 3, 4 and hurried jobs are byte-identical with acceleration', {skip: !supportsSIMD}, () => {
  for(const c of coreCases().filter(c=>c.quality===100))for(const effort of [1,3,4]) {
    const outputs=[];
    for(const mode of modes) {use(mode);outputs.push(encode(c.data,c.width,c.height,{effort}));}
    assert.deepEqual(outputs[1],outputs[0],c.name);assert.deepEqual(outputs[2],outputs[0],c.name);
    const first=encode(c.data,c.width,c.height,{effort:1});assert.ok(outputs[0].length<=first.length);
    for(const mode of modes) {use(mode);const job=encodeSteps(c.data,c.width,c.height,{effort});job.hurry=true;for(const _ of job);assert.deepEqual(job.bytes,first);}
  }
  use('off');
});

test('absent SIMD, absent WASM and CSP rejection keep the exact JavaScript stream', () => {
  const url=new URL('../src/kernels.mjs',import.meta.url).href, effortURL=new URL('../src/effort.mjs',import.meta.url).href;
  for(const scenario of ['no-simd','no-wasm','csp']) {
    const source=`import assert from 'node:assert/strict';import {encode} from ${JSON.stringify(effortURL)};import {configureKernels,kernelMode} from ${JSON.stringify(url)};
    const d=Uint8Array.from({length:17*19*4},(_,i)=>(i*13)&255),before=[1,3,4,9].map(effort=>encode(d,17,19,{effort}));
    // Scope the simulated platform to the encoder checks; queued host startup may still need WebAssembly.
    const wasm=WebAssembly,validate=wasm.validate,Module=wasm.Module;
    try {
    ${scenario==='no-simd'?'WebAssembly.validate=()=>false;':scenario==='no-wasm'?'globalThis.WebAssembly=undefined;':'WebAssembly.Module=function(){throw new Error("blocked by CSP")};'}
    assert.equal(configureKernels('auto'),'off');assert.equal(kernelMode(),'off');
    for(const [i,effort]of [1,3,4,9].entries())assert.deepEqual(encode(d,17,19,{effort}),before[i]);
    } finally {globalThis.WebAssembly=wasm;wasm.validate=validate;wasm.Module=Module;}
    console.log('fallback exact');`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:30000});
    assert.equal(child.status,0,scenario+': '+child.stderr);assert.match(child.stdout,/fallback exact/);
  }
});

test('refused weighted arena growth keeps exact JavaScript residuals', {skip: !supportsSIMD}, () => {
  const source = `import assert from 'node:assert/strict';
    import {configureKernels} from ${JSON.stringify(new URL('../src/kernels.mjs', import.meta.url).href)};
    import {codeWeighted} from ${JSON.stringify(new URL('../src/weighted.mjs', import.meta.url).href)};
    const width=512,height=600,n=width*height,plane=Int16Array.from({length:n},(_,i)=>(i*173%511)-255);
    const run=()=>{const residuals=new Uint32Array(n),properties=new Int32Array(n);
      codeWeighted(null,null,plane,width,height,0,undefined,residuals,properties);return {residuals,properties};};
    configureKernels('off');const expected=run();assert.equal(configureKernels('scalar'),'scalar');
    const grow=WebAssembly.Memory.prototype.grow;let attempts=0;
    try {WebAssembly.Memory.prototype.grow=function(){attempts++;throw new RangeError('allocation refused');};
      const actual=run();for(const name of ['residuals','properties']) {
        const a=actual[name],b=expected[name];
        assert.ok(Buffer.from(a.buffer,a.byteOffset,a.byteLength).equals(Buffer.from(b.buffer,b.byteOffset,b.byteLength)),
          'allocation refusal: '+name);
      }assert.equal(attempts,1);
    } finally {WebAssembly.Memory.prototype.grow=grow;configureKernels('off');}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {encoding: 'utf8', timeout: 30000});
  assert.equal(child.status, 0, child.stderr);
});

test('non-exact multipliers, non-Int16 planes and custom writers stay in JS', {skip: !supportsSIMD}, () => {
  use('simd');assert.equal(kernelHooks.channel(null,new Uint32Array(257),new Int32Array(16),4,4,leaf(5)),false);
  // A raw histogram that is written, one that is too small or too large for the arena, a configuration whose tokens leave the alphabet.
  assert.equal(kernelHooks.channel(new BitWriter(),buildCode(new Uint32Array(257)),new Int16Array(16),4,4,leaf(5),true),false);
  assert.equal(kernelHooks.channel(null,new Uint32Array(20),new Int16Array(16),4,4,leaf(5),true),false);
  assert.equal(kernelHooks.channel(null,new Uint32Array(4130),new Int16Array(16),4,4,leaf(5),true),false);
  assert.equal(kernelHooks.channel(null,new Uint32Array(257),new Int16Array(16),4,4,Object.assign(leaf(5),{config:uintConfig(12,3,3)})),false);
  assert.equal(kernelHooks.channel(null,new Uint32Array(257),new Int16Array(16),4,4,Object.assign(leaf(5),{config:{split:2,msb:2,lsb:1,splitToken:4}})),false);
  assert.equal(kernelHooks.channel(null,new Uint32Array(257),new Int16Array(16),4,4,leaf(5,0,2)),false);
  const writer=new BitWriter();writer.write=function(){throw new Error('custom writer reached')};
  assert.equal(kernelHooks.channel(writer,buildCode(new Uint32Array(257)),new Int16Array(16),4,4,leaf(5)),false);
  assert.throws(()=>codeChannel(writer,buildCode(new Uint32Array(257)),new Int16Array(16),4,4,leaf(5)),/custom writer reached/);
  use('off');assert.equal(kernelMode(),'off');
});
