// An app that has both npm names ships one encoder. jpegxl and the rapier-jxl pointer package (both as tarballs) are
// installed together in one project whose page imports createCodec from 'jpegxl/codec' and from 'rapier-jxl/codec' and
// encodes through each. Built with Vite and with webpack, and again with only jpegxl as the control. A build passes when
// its output holds the encoder exactly as often as the control's (counted by a run of the upload module's inline
// WebAssembly, and by SHA-256 of every emitted worker file), and the page, served from the build in Chromium, encodes
// the same bytes through both names.
//   node both-names.mjs <jpegxl.tgz> <rapier-jxl.tgz> [--vite 7.3.8] [--webpack 5.101.3]
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve, extname} from 'node:path';
import {createRequire} from 'node:module';

const args = process.argv.slice(2), flag = name => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const vite = flag('--vite') ?? '7.3.8', webpack = flag('--webpack') ?? '5.101.3';
const [jpegxl, pointer] = args.map(p => p && resolve(p));
if (!jpegxl || !pointer) { console.error('usage: node both-names.mjs <jpegxl.tgz> <rapier-jxl.tgz>'); process.exit(2); }
const work = mkdtempSync(join(tmpdir(), 'jxl-both-'));
const run = (cmd, argv, cwd) => execFileSync(cmd, argv, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
const tarballs = {jpegxl, 'rapier-jxl': pointer};
mkdirSync(join(work, 'jpegxl'));
run('tar', ['xzf', jpegxl, '-C', join(work, 'jpegxl'), '--strip-components=1'], work);

// A run of the encoder's packed WebAssembly: the largest string literal in upload.worker.mjs, and in it the longest
// run of plain printable ASCII (a bundler may re-escape anything else). It must occur once in that file; every copy
// of the encoder in a build carries it once.
const upload = readFileSync(join(work, 'jpegxl/dist/upload.worker.mjs'), 'latin1');
let literal = '';
for (const m of upload.matchAll(/"(?:[^"\\]|\\.){10000,}"|'(?:[^'\\]|\\.){10000,}'|`[^`]{10000,}`/g)) if (m[0].length > literal.length) literal = m[0];
const plain = [...literal.slice(1, -1).matchAll(/[ !#%&(-[\]-_a-z{-~]{64,}/g)].map(m => m[0]).reduce((a, b) => b.length > a.length ? b : a, '');
const marker = plain.slice(Math.floor((plain.length - 64) / 2), Math.floor((plain.length - 64) / 2) + 64);
if (marker.length !== 64 || upload.split(marker).length !== 2) throw new Error('no marker found once in upload.worker.mjs');

const page = both => `import {createCodec as a} from 'jpegxl/codec';
${both ? "import {createCodec as b} from 'rapier-jxl/codec';" : 'const b = a;'}
const px = (w, h) => { const d = new Uint8Array(w * h * 4); for (let i = 0; i < d.length; i += 4) { d[i] = (i * 7) & 255; d[i + 1] = (i >> 5) & 255; d[i + 2] = 128; d[i + 3] = 255; } return {data: d, width: w, height: h}; };
const hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
const out = {};
try {
  for (const [name, make] of [['jpegxl', a], ['rapier-jxl', b]]) { const c = make({module: 'rapier-jxl/upload'}); out[name] = await hex((await c.encode(px(128, 128), {effort: 3})).bytes); await c.close(); }
} catch (e) { out.error = String(e?.message || e); }
document.title = JSON.stringify(out);
`;
const files = dir => readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]);
function census(dir) {
  let copies = 0;
  const workers = [];
  for (const file of files(dir)) {
    const text = readFileSync(file, 'latin1');
    copies += text.split(marker).length - 1;
    if (/\.(m?js)$/.test(file) && /worker|helper/.test(file)) workers.push(createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16));
  }
  return {copies, workers: workers.sort()};
}

const types = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'};
async function serve(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try { const body = readFileSync(join(dir, path === '/' ? 'index.html' : path)); res.setHeader('content-type', types[extname(path === '/' ? 'index.html' : path)] || 'application/octet-stream'); res.end(body); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return server;
}
const playwright = createRequire(import.meta.url)('playwright');
const browser = await playwright.chromium.launch();
async function open(dir) {
  const server = await serve(dir), tab = await browser.newPage();
  try {
    await tab.goto(`http://127.0.0.1:${server.address().port}/`);
    await tab.waitForFunction(() => document.title.startsWith('{'), null, {timeout: 120000});
    return JSON.parse(await tab.title());
  } catch (e) { return {error: String(e.message).slice(0, 120)}; } finally { await tab.close(); server.close(); }
}

function project(tool, both) {
  const dir = join(work, `${tool}-${both ? 'both' : 'jpegxl'}`);
  mkdirSync(join(dir, 'src'), {recursive: true});
  const deps = {jpegxl: tarballs.jpegxl, ...(both && {'rapier-jxl': tarballs['rapier-jxl']}),
    ...(tool === 'vite' ? {vite} : {webpack, 'webpack-cli': '6.0.1'})};
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'both', private: true, type: 'module', dependencies: deps}));
  writeFileSync(join(dir, 'src/main.js'), page(both));
  if (tool === 'vite') {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="/src/main.js"></script>');
  } else {
    writeFileSync(join(dir, 'webpack.config.js'), "export default {mode: 'production', entry: './src/main.js', output: {path: new URL('./dist', import.meta.url).pathname, publicPath: '/'}, experiments: {outputModule: true}};");
  }
  run('npm', ['install', '--no-audit', '--no-fund', '--silent'], dir);
  if (tool === 'vite') run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'error'], dir);
  else {
    run(process.execPath, ['node_modules/webpack-cli/bin/cli.js', '--no-stats'], dir);
    writeFileSync(join(dir, 'dist/index.html'), '<!doctype html><script type="module" src="/main.mjs"></script>');
  }
  return join(dir, 'dist');
}

let failed = 0;
for (const tool of ['vite', 'webpack']) {
  const control = project(tool, false), both = project(tool, true);
  const c = census(control), b = census(both), result = await open(both);
  const problems = [];
  if (b.copies !== c.copies) problems.push(`${b.copies} copies of the encoder, the control ${c.copies}`);
  if (JSON.stringify(b.workers) !== JSON.stringify(c.workers)) problems.push(`workers ${JSON.stringify(b.workers)}, the control ${JSON.stringify(c.workers)}`);
  if (result.error || !result.jpegxl || result.jpegxl !== result['rapier-jxl']) problems.push('page: ' + JSON.stringify(result));
  failed += problems.length > 0;
  console.log(`${problems.length ? 'FAIL' : 'OK  '} ${tool}: ${b.copies} encoder copies (control ${c.copies}), ${b.workers.length} worker files, ` +
    `page ${JSON.stringify(result)}${problems.length ? '; ' + problems.join('; ') : ''}`);
}
await browser.close();
process.exitCode = failed ? 1 : 0;
