/** Diagnose native JXL decoder + canvas rounding on translucent samples. Not a speed test. */
import { writeFile } from 'node:fs/promises';
import { serve } from '../../examples/snapdom/serve.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { server, url } = await serve();
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM||undefined,args:['--no-sandbox','--enable-features=JXL']});
const report={browser:browser.version(),method:'Decode fixture PNG to canvas RGBA; encode exact JXL; native decode JXL to canvas. Compare straight samples and alpha-weighted samples. This isolates native decoder/canvas readback, not codestream correctness (tested with djxl).',rows:[]};
try {
  const page=await browser.newPage(); await page.goto(`${url}/examples/snapdom/scene.html`);
  for(const name of ['snapdom-alpha-1920x1080','snapdom-nested-demo-1920x1080']) {
    const row=await page.evaluate(async name=>{
      const{encode}=await import('/dist/capture.min.mjs');
      const original=await createImageBitmap(await fetch(`/bench/capture/fixtures/${name}.png`).then(r=>r.blob()));
      const canvas=new OffscreenCanvas(original.width,original.height),context=canvas.getContext('2d',{willReadFrequently:true});
      context.drawImage(original,0,0);original.close();
      const input=context.getImageData(0,0,canvas.width,canvas.height),bytes=await encode(input,{gpu:'cpu'});
      const jxl=await createImageBitmap(new Blob([bytes],{type:'image/jxl'}));
      context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(jxl,0,0);jxl.close();
      const output=context.getImageData(0,0,canvas.width,canvas.height).data;
      let rgbMax=0,alphaMax=0,premultipliedMax=0,opaqueDifferences=0,transparentDifferences=0,differentRGB=0;
      const changedAlphaLevels=new Set();
      for(let i=0;i<output.length;i+=4){
        const alpha=input.data[i+3];alphaMax=Math.max(alphaMax,Math.abs(output[i+3]-alpha));
        for(let c=0;c<3;c++){
          const error=Math.abs(output[i+c]-input.data[i+c]);
          rgbMax=Math.max(rgbMax,error);premultipliedMax=Math.max(premultipliedMax,error*alpha/255);
          if(error){differentRGB++;changedAlphaLevels.add(alpha);if(alpha===255)opaqueDifferences++;if(alpha===0)transparentDifferences++;}
        }
      }
      return{width:canvas.width,height:canvas.height,bytes:bytes.length,differentRGB,rgbMax,alphaMax,premultipliedMax,opaqueDifferences,transparentDifferences,changedAlphaLevels:[...changedAlphaLevels].sort((a,b)=>a-b)};
    },name);
    report.rows.push({input:name,...row});
  }
  await writeFile(new URL('./browser-alpha-results.json',import.meta.url),`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify(report));
} finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
