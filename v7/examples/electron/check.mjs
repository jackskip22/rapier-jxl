// Drives the app with Playwright's Electron support: a dropped photo, a chosen JPEG's round trip, a video, cancel, a refusal,
// and Save through the main process's dialog (answered by the test). JXL_PACKAGE names the built package.
// cd examples/electron && npm install && JXL_PACKAGE=/built/package npm run assets && npm run check
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {_electron as electron} from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../desktop/fixtures');
const pkg = resolve(process.env.JXL_PACKAGE ?? join(here, 'node_modules/jpegxl'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = await import(pathToFileURL(join(pkg, 'dist/decode.mjs')).href);
const photo = await readFile(join(fixtures, 'photo.jpg'));
const out = await mkdtemp(join(tmpdir(), 'jxl-electron-'));
const report = {status: 'FAIL', cases: []};
const row = (name, extra = {}) => report.cases.push({name, ...extra});
let app;
try {
  app = await electron.launch({args: [here, '--no-sandbox', '--disable-gpu'], env: {...process.env, ELECTRON_ENABLE_LOGGING: '1'}});
  const page = await app.firstWindow();
  const requests = [], errors = [];
  page.on('request', request => { if (!/^(app|blob|data):/.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('load');
  report.electron = await app.evaluate(() => `${process.versions.electron} (Chromium ${process.versions.chrome})`);
  const isolated = await page.evaluate(() => ({coi: crossOriginIsolated, node: typeof process + typeof require, bridge: Object.keys(window.rapierDesktop)}));
  assert(isolated.coi, 'The page is not cross-origin isolated.');
  assert.equal(isolated.node, 'undefinedundefined', 'The page can reach Node.');
  const status = () => page.locator('#status').evaluate(node => node.value);
  const settled = () => page.waitForFunction(() => !document.querySelector('#photo').disabled && /bytes from|^JXL_/.test(document.querySelector('#status').value), null, {timeout: 120000});
  const dropFile = (name, type, base64) => page.evaluate(({name, type, base64}) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, {type}));
    dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}));
  }, {name, type, base64});
  const saveTo = async name => {
    const path = join(out, name);
    await app.evaluate(({dialog}, path) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: path}); }, path);
    await page.locator('#save').click();
    await page.waitForFunction(() => /^Saved /.test(document.querySelector('#status').value));
    assert.equal((await status()).split('\n')[1], path);
    return readFile(path);
  };

  // 1. A dropped photo.
  await dropFile('photo.jpg', 'image/jpeg', photo.toString('base64')); await settled();
  assert.match(await status(), /bytes from/);
  let jxl = await saveTo('photo.jxl');
  const shown = await decoder.decode(new Uint8Array(jxl));
  assert(shown.width > 0 && shown.height > 0);
  row('drop-photo', {input: photo.length, bytes: jxl.length, width: shown.width, height: shown.height});

  // 2. A chosen JPEG: recompressed, restored to the same file.
  await page.locator('#jpeg-file').setInputFiles(join(fixtures, 'photo.jpg')); await settled();
  assert((await status()).includes(`same file: ${sha256(photo)}`), await status());
  jxl = await saveTo('photo-jpeg.jxl');
  const {restore} = await import(pathToFileURL(join(pkg, 'dist/jpeg.node.mjs')).href);
  assert.equal(sha256((await restore(new Uint8Array(jxl))).bytes), sha256(photo));
  row('jpeg-round-trip', {jxl: jxl.length, restoredSha256: sha256(photo)});

  // 3. A video becomes an animated JPEG XL.
  await page.locator('#video-file').setInputFiles(join(fixtures, 'train.mp4')); await settled();
  jxl = await saveTo('train.jxl');
  const clip = await decoder.decode(new Uint8Array(jxl));
  const seconds = clip.frames.reduce((sum, frame) => sum + frame.durationSeconds, 0);
  assert(clip.frames.length > 1 && Math.abs(seconds - 2) < 0.1, `${clip.frames.length} frames, ${seconds} s`);
  row('video', {bytes: jxl.length, frames: clip.frames.length, seconds: +seconds.toFixed(3)});

  // 4. Cancel while a video runs; the next call runs.
  await page.locator('#video-file').setInputFiles(join(fixtures, 'train.mp4'));
  await page.waitForFunction(() => !document.querySelector('#cancel').disabled);
  await page.locator('#cancel').click(); await settled();
  assert.match(await status(), /^JXL_CANCELED/);
  assert.equal(await page.locator('#save').isDisabled(), true);
  row('cancel', {status: (await status()).split(':')[0]});
  await page.locator('#photo-file').setInputFiles(join(fixtures, 'photo.jpg')); await settled();
  assert.match(await status(), /bytes from/); row('after-cancel');

  // 5. A refusal carries the package's code and writes no file.
  await page.locator('#jpeg-file').setInputFiles({name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a JPEG')}); await settled();
  assert.match(await status(), /^JXL_[A-Z0-9_]+:/); assert.equal(await page.locator('#save').isDisabled(), true);
  row('bad-input', {code: (await status()).split(':')[0]});

  // 6. The Node files in a main process.
  const mainRun = spawnSync((await import('electron')).default, [join(here, 'main-check.mjs'), join(fixtures, 'photo.jpg'), '--no-sandbox'], {env: {...process.env, NODE_OPTIONS: '', JXL_PACKAGE: pkg}, encoding: 'utf8', timeout: 120000});
  const main = JSON.parse(/RESULT (.*)/.exec(mainRun.stdout)?.[1] ?? 'null');
  assert(main?.stillBytes && main.jpegBytes && main.restored, mainRun.stdout + mainRun.stderr); row('main-process', main);

  assert.deepEqual(requests, [], 'A request left the app.'); assert.deepEqual(errors, []);
  report.status = 'PASS';
} catch (error) {
  report.error = {code: error.code || error.name, message: error.message}; process.exitCode = 1;
} finally {
  await app?.close(); await rm(out, {recursive: true, force: true});
  console.log(JSON.stringify(report, null, 2));
}
