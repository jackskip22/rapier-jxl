// Runs the built page and the real Filesystem web implementation; no native-host claim.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, dirname, extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(process.env.JXL_PACKAGE || resolve(here, '../..'));
assert(process.env.JXL_TEST_JPEG, 'Set JXL_TEST_JPEG to a real JPEG photograph.');
const jpeg = resolve(process.env.JXL_TEST_JPEG), source = await readFile(jpeg);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css'};
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const root = path.startsWith('/package/') ? pkg : resolve(here, 'dist');
    const file = resolve(root, path.startsWith('/package/') ? path.slice('/package/'.length) : '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  const context = await browser.newContext();
  const remoteRequests = [], pageErrors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    remoteRequests.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin);
  const rows = [];
  for (const operation of ['photo', 'jpeg']) {
    await page.locator(`#${operation}-file`).setInputFiles(jpeg);
    await page.waitForFunction(() => !document.querySelector('#photo').disabled && /^(Saved |JXL_)/.test(document.querySelector('#status').value));
    const shown = await page.locator('#status').textContent();
    assert(shown.startsWith('Saved '), shown);
    const saved = await page.evaluate(async ({operation, source, name}) => {
      const path = document.querySelector('#status').value.split('\n')[1];
      const read = await window.Capacitor.Plugins.Filesystem.readFile({path});
      const stored = Uint8Array.from(atob(read.data), character => character.charCodeAt(0));
      const original = Uint8Array.from(atob(source), character => character.charCodeAt(0));
      const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), byte => byte.toString(16).padStart(2, '0')).join('');
      let expected, restoredSha256 = null;
      if (operation === 'photo') {
        const {encode, close} = await import('/package/dist/upload.browser.mjs');
        expected = (await encode(new File([original], name, {type: 'image/jpeg'}), {effort: 3, fidelity: {quality: 80}})).bytes;
        await close();
      } else {
        const {recompress, restore, close} = await import('/package/dist/jpeg.browser.mjs');
        expected = (await recompress(original)).bytes;
        restoredSha256 = await hash((await restore(stored)).bytes);
        await close();
      }
      return {operation, path, bytes: stored.byteLength, storedSha256: await hash(stored), expectedSha256: await hash(expected), restoredSha256};
    }, {operation, source: source.toString('base64'), name: basename(jpeg)});
    assert(saved.bytes > 0);
    assert.equal(saved.storedSha256, saved.expectedSha256, `${operation}: Filesystem saved the encoded bytes`);
    if (operation === 'jpeg') assert.equal(saved.restoredSha256, sha256(source), 'Stored JPEG XL restores the original JPEG');
    rows.push(saved);
  }
  assert.notEqual(rows[0].path, rows[1].path, 'A new conversion keeps the earlier file');
  await page.locator('#jpeg-file').setInputFiles({name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a JPEG')});
  await page.waitForFunction(() => !document.querySelector('#photo').disabled && /^JXL_/.test(document.querySelector('#status').value));
  assert.equal(await page.locator('#share').isDisabled(), true, 'A refused image has no output to share');
  const savedFiles = await page.evaluate(() => window.Capacitor.Plugins.Filesystem.readdir({path: '', directory: 'DATA'}));
  assert.equal(savedFiles.files.length, 2, 'Refused JPEG writes no file');
  assert.deepEqual(remoteRequests, [], 'Conversion uses only local assets');
  assert.deepEqual(pageErrors, []);
  const modules = Object.fromEntries(await Promise.all(['upload', 'jpeg'].map(async name => [name, sha256(await readFile(resolve(pkg, `dist/${name}.mjs`)))])));
  console.log(JSON.stringify({status: 'PASS', chromium: browser.version(), sourceSha256: sha256(source), modules, rows, refusal: 'PASS', nativeFilesystem: 'NOT PROVEN', nativeShare: 'NOT PROVEN'}, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
