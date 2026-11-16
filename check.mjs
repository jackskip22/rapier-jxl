// Video in, in Chromium, Firefox and WebKit: each clip becomes an animated JPEG XL; decoded back, it has the clip's frames.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {chromium, firefox, webkit} from 'playwright';

const root = resolve('.'), engines = {chromium, firefox, webkit};
const types = {'.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.webm': 'video/webm'};
const page = `<!doctype html><meta charset="utf-8"><script type="module">
import {encode} from '/package/dist/animation.browser.mjs';
import {decode} from '/package/dist/decode.browser.mjs';
const blob = async url => (await fetch(url)).blob();
const code = async run => { try { await run(); return 'none'; } catch (e) { return e?.name === 'AbortError' ? 'AbortError' : String(e?.code ?? e?.name); } };
window.clip = async url => {
  const started = performance.now(), made = await encode(await blob(url), {effort: 1});
  const back = await decode(made.bytes);
  const frames = back.frames ?? [back];
  return {bytes: made.bytes.length, frames: frames.length, ms: Math.round(performance.now() - started),
    durationMs: Math.round(frames.reduce((sum, f) => sum + (f.durationSeconds ?? 0) * 1000, 0))};
};
window.cancel = async url => { const stop = new AbortController(); setTimeout(() => stop.abort(), 50);
  return code(async () => encode(await blob(url), {effort: 1, signal: stop.signal})); };
window.broken = () => code(() => encode(new Blob([new Uint8Array(4096).fill(7)], {type: 'video/webm'}), {effort: 1}));
window.ready = true;
</script>`;
const server = createServer(async (q, r) => {
  const path = new URL(q.url, 'http://x').pathname;
  if (path === '/') { r.writeHead(200, {'content-type': 'text/html'}); r.end(page); return; }
  try { const file = resolve(root, '.' + decodeURIComponent(path)); if (!file.startsWith(root + '/')) throw 0;
    const body = await readFile(file); r.writeHead(200, {'content-type': types[extname(file)] || 'application/octet-stream'}); r.end(body); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const origin = 'http://127.0.0.1:' + server.address().port, clips = process.argv.slice(2);
let failed = 0;
for (const name of (process.env.ENGINES || 'chromium,firefox,webkit').split(',')) {
  const browser = await engines[name].launch(), tab = await browser.newPage();
  await tab.goto(origin + '/'); await tab.waitForFunction(() => window.ready, null, {timeout: 60000});
  for (const clip of clips) {
    try { const row = await tab.evaluate(url => window.clip(url), '/' + clip);
      const ok = row.frames > 1 && row.bytes > 0; if (!ok) failed++;
      console.log([name, clip, ok ? 'ok' : 'FAIL', row.frames + ' frames', row.durationMs + ' ms shown', row.bytes + ' B', row.ms + ' ms'].join('\t'));
    } catch (e) { failed++; console.log([name, clip, 'FAIL', String(e.message).slice(0, 200)].join('\t')); }
  }
  const cancelled = await tab.evaluate(url => window.cancel(url), '/' + clips[0]);
  const broken = await tab.evaluate(() => window.broken());
  if (cancelled !== 'AbortError') failed++; if (broken !== 'JXL_INPUT') failed++;
  console.log([name, 'cancel', cancelled === 'AbortError' ? 'ok' : 'FAIL', cancelled].join('\t'));
  console.log([name, 'unplayable', broken === 'JXL_INPUT' ? 'ok' : 'FAIL', broken].join('\t'));
  await browser.close();
}
server.close();
process.exit(failed ? 1 : 0);
