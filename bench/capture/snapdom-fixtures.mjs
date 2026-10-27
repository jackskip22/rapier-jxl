/** Real SnapDOM captures, native browser encoders, deterministic local assets. */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { serve } from '../../examples/snapdom/serve.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = new URL('./fixtures/', import.meta.url);
await mkdir(output, { recursive: true });
const { server, url } = await serve();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM || undefined, args: ['--no-sandbox', '--enable-features=JXL'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const results = { schema: 1, browser: browser.version(), machine: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model }, snapdomCommit: 'f7bb642d83ece9f6efdca0825ab87bb7b2274650', capture: { compress: false, embedFonts: false, dpr: 1 }, timing: 'First toBlob call then three repeats; same captured canvas. Encode callback completion, excludes DOM capture/rasterization. Canvas cannot request lossless WebP explicitly.', inputs: [], encodes: [] };
try {
  for (const kind of ['opaque', 'alpha', 'nested-demo']) {
    await page.goto(`${url}/examples/snapdom/scene.html${kind === 'alpha' ? '?alpha' : ''}`);
    if (kind === 'nested-demo') {
      const source = await readFile(new URL('../../examples/snapdom/vendor/nested.html', import.meta.url), 'utf8');
      await page.setContent(source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
      await page.addStyleTag({ content: ':root{--base-rgb:245,245,242;--text-rgb:30,40,33;--border-rgb:95,130,105;--accent-rgb:65,150,100}.chart{width:960px!important;height:540px!important;min-height:540px!important}' });
    }
    for (const width of kind === 'nested-demo' ? [1920] : [1920, 3840]) {
      const height = width * 9 / 16;
      const result = await page.evaluate(async ({ width, height, kind, origin }) => {
        const { snapdom } = await import(`${origin}/examples/snapdom/vendor/snapdom.mjs`);
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.decode()));
        const source = document.querySelector(kind === 'nested-demo' ? '.chart' : '#capture');
        const start = performance.now();
        const capture = await snapdom(source, { width, height, dpr: 1, compress: false, embedFonts: false });
        const canvas = await capture.toCanvas();
        const captureMs = performance.now() - start;
        const encode = type => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob returned null')), type, 0.9));
        const encodes = [];
        let png;
        for (const type of ['image/png', 'image/webp']) {
          const samples = [];
          let blob;
          for (let i = 0; i < 4; i++) {
            const start = performance.now(); blob = await encode(type); samples.push(performance.now() - start);
          }
          if (type === 'image/png') png = blob;
          encodes.push({ codec: type === 'image/png' ? 'browser-png' : 'browser-webp-q90', type: blob.type, bytes: blob.size, coldMs: samples[0], warmMs: samples.slice(1), memory: null, memoryNote: 'Browser canvas native allocations are not exposed; no peak claimed.' });
        }
        const bytes = new Uint8Array(await png.arrayBuffer());
        let binary = ''; for (let i = 0; i < bytes.length; i += 65536) binary += String.fromCharCode(...bytes.subarray(i, i + 65536));
        return { width: canvas.width, height: canvas.height, captureMs, png: btoa(binary), encodes };
      }, { width, height, kind, origin: url });
      const name = `snapdom-${kind}-${width}x${height}`;
      const png = Buffer.from(result.png, 'base64');
      await writeFile(new URL(`${name}.png`, output), png);
      results.inputs.push({ name, file: `${name}.png`, width: result.width, height: result.height, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), captureMs: result.captureMs, source: kind === 'nested-demo' ? 'snapdom demos/d8-nested-elements.html (scripts removed, fixed CSS colour variables, 960x540 layout)' : 'examples/snapdom/scene.html (960x540 layout)' });
      for (const encoded of result.encodes) results.encodes.push({ input: name, ...encoded });
      console.log(`${name}: ${png.length} bytes; capture ${result.captureMs.toFixed(1)} ms`);
    }
  }
  await writeFile(new URL('manifest.json', output), `${JSON.stringify(results, null, 2)}\n`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
