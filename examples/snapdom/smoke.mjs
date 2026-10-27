/** Exercise the actual offline demo, worker cancellation and restart. */
import { writeFile } from 'node:fs/promises';
import { serve } from './serve.mjs';
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {server,url}=await serve();
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM||undefined,args:['--no-sandbox','--enable-features=JXL']});
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
  const inspect=()=>page.evaluate(async()=>{
    const link=document.querySelector('#save'),blob=await fetch(link.href).then(response=>response.blob());
    const decoded=await createImageBitmap(blob),result={type:blob.type,bytes:blob.size,width:decoded.width,height:decoded.height,status:document.querySelector('output').value};
    decoded.close();return result;
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
  if(first.type!=='image/jxl'||first.width!==1920||first.height!==1080||restarted.bytes!==first.bytes||cancelled!=='Capture cancelled.'||failures.length||blocked.length)
    throw new Error(JSON.stringify({first,restarted,cancelled,failures,blocked}));
  const report={browser:browser.version(),method:'Functional demo checks; UI timings are not benchmark medians.',first,cancelled,restarted,failures,blocked,offline:true};
  await writeFile(new URL('../../bench/capture/demo-results.json',import.meta.url),`${JSON.stringify(report,null,2)}\n`);
  if(process.env.DEMO_SCREENSHOT)await page.screenshot({path:process.env.DEMO_SCREENSHOT,fullPage:true});
  console.log(JSON.stringify(report));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
