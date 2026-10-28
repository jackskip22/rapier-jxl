// SPDX-License-Identifier: MIT
/** Exercise the actual offline demo, worker cancellation and restart. */
import { serve } from './serve.mjs';
// playwright-core, as every other harness uses (PLAYWRIGHT_MODULE overrides).
const playwright=await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core'),{ chromium }=playwright.default ?? playwright;
const {server,url}=await serve();
// Chrome refuses its sandbox under root; a root run is a diagnostic, not a normal-sandbox result (the report says which).
const uid=process.getuid?.(),launchArgs=uid===0?['--no-sandbox']:[],sandbox=launchArgs.length?'none (root)':'normal';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM||undefined,args:launchArgs});
const failures=[],blocked=[];
try {
  const page=await browser.newPage({viewport:{width:1200,height:1000}});
  page.on('pageerror',error=>failures.push(error.message));
  await page.route('**/*',route=>{
    const address=route.request().url();
    if(address.startsWith(url)||address.startsWith('data:')||address.startsWith('blob:'))return route.continue();
    blocked.push(address);return route.abort();
  });
  await page.addInitScript(()=>{
    const Original=Worker;globalThis.workerRequests=0;
    globalThis.Worker=class extends Original {
      postMessage(...args){globalThis.workerRequests++;return super.postMessage(...args);}
    };
  });
  await page.goto(`${url}/examples/snapdom/index.html`);
  await page.locator('iframe').evaluate(frame=>Promise.all([...frame.contentDocument.images].map(image=>image.decode())));
  await page.locator('#capture').click();
  await page.locator('#save').waitFor({state:'visible',timeout:30000});
  // The saved file, decoded with the package's own decoder and compared sample by sample with SnapDOM's canvas.
  const inspect=()=>page.evaluate(async()=>{
    const link=document.querySelector('#save'),blob=await fetch(link.href).then(response=>response.blob());
    const {decode}=await import('../../dist/decode.mjs'),decoded=await decode(new Uint8Array(await blob.arrayBuffer()));
    const canvas=await globalThis.lastCapture.result.toCanvas(),source=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let exact=decoded.width===canvas.width&&decoded.height===canvas.height;
    for(let i=0;exact&&i<source.length;i++)exact=decoded.data[i]===source[i];
    return {type:blob.type,bytes:blob.size,width:decoded.width,height:decoded.height,exact,status:document.querySelector('output').value};
  });
  const first=await inspect();
  await page.locator('#size').selectOption('3840');
  await page.locator('#capture').click();
  await page.waitForFunction(()=>globalThis.workerRequests>=2);
  await page.locator('#cancel').click();
  await page.waitForFunction(()=>!document.querySelector('#capture').disabled);
  const cancelled=await page.locator('output').textContent();
  await page.locator('#size').selectOption('1920');
  await page.locator('#capture').click();
  await page.locator('#save').waitFor({state:'visible',timeout:30000});
  const restarted=await inspect();
  if(first.type!=='image/jxl'||first.width!==1920||first.height!==1080||!first.exact||!restarted.exact||restarted.bytes!==first.bytes||cancelled!=='Capture canceled.'||failures.length||blocked.length)
    throw new Error(JSON.stringify({first,restarted,cancelled,failures,blocked}));
  const report={browser:browser.version(),uid,launchArgs,sandbox,method:'Functional demo checks; UI timings are not benchmark medians.',first,cancelled,restarted,failures,blocked,offline:true};
  if(process.env.DEMO_SCREENSHOT)await page.screenshot({path:process.env.DEMO_SCREENSHOT,fullPage:true});
  console.log(JSON.stringify(report));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
