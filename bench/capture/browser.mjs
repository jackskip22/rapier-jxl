/** Browser main/worker capture benchmark. Requires npm run build and generated fixtures. */
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { serve } from '../../examples/snapdom/serve.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const manifest = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url)));
const { server, url } = await serve();
const browser = await chromium.launch({ headless:true, executablePath:process.env.CHROMIUM || undefined, args:['--no-sandbox','--enable-features=JXL'] });
const report = {
  schema:1, browser:browser.version(), machine:{ cpu:os.cpus()[0].model, platform:os.platform(), release:os.release() },
  method:'Fresh page per case; first encode then three repeats. Main timing excludes module fetch; worker timing includes startup on first call. RGBA input was decoded before timing. Wall clock includes borrowed-input copy, messaging and result receipt. Native JXL decode uses createImageBitmap then canvas RGBA readback; alpha readback can incur browser premultiplication rounding. No GPU hardware speed claim is made for a missing or software adapter.',
  memory:{ peak:null, reason:'Browser native/GPU allocation peak is not exposed by this harness; Node process RSS is measured separately.' },
  rows:[],
};
try {
  for (const fixture of manifest.inputs) for (const execution of ['main','worker']) for (const mode of ['exact','near-cpu','near-auto']) {
    const page = await browser.newPage();
    await page.goto(`${url}/examples/snapdom/scene.html`);
    try {
      const row = await page.evaluate(async ({file, execution, mode}) => {
        const { encode } = await import('/dist/capture.min.mjs');
        const { createEncoder } = await import('/dist/image.min.mjs');
        const blob = await fetch(`/bench/capture/fixtures/${file}`).then(r=>r.blob());
        const image = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(image.width,image.height);
        const ctx = canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(image,0,0); image.close();
        const rgba = ctx.getImageData(0,0,canvas.width,canvas.height);
        const maxError = mode==='exact'?0:1, gpu=mode==='near-auto'?'auto':'cpu';
        const client = execution==='worker' ? createEncoder({worker:()=>new Worker('/dist/capture-worker.js',{type:'module'})}) : null;
        const times=[]; let bytes;
        try {
          for(let iteration=0;iteration<4;iteration++) {
            const start=performance.now();
            bytes=await (client?client.encode(rgba,{maxError,gpu}):encode(rgba,{maxError,gpu}));
            times.push(performance.now()-start);
          }
        } finally { client?.close(); }
        let roundTrip;
        try {
          const decoded=await createImageBitmap(new Blob([bytes],{type:'image/jxl'}));
          const restored=new OffscreenCanvas(decoded.width,decoded.height), render=restored.getContext('2d',{willReadFrequently:true});
          render.drawImage(decoded,0,0); decoded.close();
          const actual=render.getImageData(0,0,restored.width,restored.height).data;
          let different=0,maxRGBError=0,maxAlphaError=0;
          for(let i=0;i<actual.length;i++) {
            const error=Math.abs(actual[i]-rgba.data[i]); if(error) different++;
            if((i&3)===3)maxAlphaError=Math.max(maxAlphaError,error);else maxRGBError=Math.max(maxRGBError,error);
          }
          roundTrip={supported:true,width:restored.width,height:restored.height,rgbaEqual:!different,differentSamples:different,maxRGBError,maxAlphaError};
        } catch(error) { roundTrip={supported:false,error:`${error.name}: ${error.message}`}; }
        let adapterInfo=null;
        if(navigator.gpu) {
          const adapter=await navigator.gpu.requestAdapter();
          if(adapter)adapterInfo={vendor:adapter.info?.vendor,architecture:adapter.info?.architecture,device:adapter.info?.device,description:adapter.info?.description,isFallbackAdapter:adapter.info?.isFallbackAdapter??adapter.isFallbackAdapter??null};
        }
        const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
        return {execution,mode,maxError,gpu,webgpu:!!navigator.gpu,adapterInfo,width:canvas.width,height:canvas.height,bytes:bytes.length,sha256:hash,coldMs:times[0],warmMs:times.slice(1),roundTrip};
      }, {file:fixture.file,execution,mode});
      report.rows.push({input:fixture.name,...row});
      console.log(`${fixture.name} ${execution} ${mode}: ${row.bytes} B, first ${row.coldMs.toFixed(1)} ms, warm ${row.warmMs.map(x=>x.toFixed(1)).join('/')} ms; browser decode ${row.roundTrip.supported}`);
    } catch(error) { report.rows.push({input:fixture.name,execution,mode,error:String(error)}); }
    finally { await page.close(); }
    await writeFile(new URL('./browser-results.json',import.meta.url),`${JSON.stringify(report,null,2)}\n`);
  }
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
