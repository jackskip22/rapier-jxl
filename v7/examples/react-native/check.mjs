// The page and the calls in Chromium against the built package, with Playwright in the place of the WebView: the same
// messages, the same bytes, no network. The app itself runs in CI (ci/react-native.yml).
// JXL_PACKAGE=/built/package PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node check.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {prepareAssets} from './prepare-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../ios/Tests/RapierJXLTests/Fixtures');
const report = {status: 'FAIL', cases: []};
let browser;
try {
  assert(process.env.JXL_PACKAGE, 'JXL_PACKAGE must name a built package.');
  const packageDir = resolve(process.env.JXL_PACKAGE);
  report.assets = (await prepareAssets({packageDir})).report.totalBytes;
  const {ORIGIN, PAGE, modules} = await import(pathToFileURL(join(here, 'src/generated/page.ts')).href);
  const {createCodec, JXLError} = await import(pathToFileURL(join(here, 'src/codec.ts')).href);
  const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch();
  report.browser = `chromium ${browser.version()}`;
  const context = await browser.newContext();
  const outside = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === ORIGIN) return route.fulfill({status: 200, contentType: 'text/html', body: PAGE});
    if (!url.startsWith('blob:')) outside.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  let receive;
  const toCodec = [];
  await page.exposeFunction('__tell', text => receive(JSON.parse(text)));
  await page.addInitScript(() => {
    window.ReactNativeWebView = {postMessage: text => window.__tell(text)};
    // The app's page is never on screen, so a video is read by seeking.
    Object.defineProperty(Document.prototype, 'visibilityState', {get: () => 'hidden'});
  });
  let sending = Promise.resolve(), sentBytes = 0;
  const loaded = [];
  const made = createCodec(
    message => { sentBytes += JSON.stringify(message).length; sending = sending.then(() => page.evaluate(m => rapier.receive(m), message)); },
    async name => { loaded.push(name); return modules[name](); });
  ({receive} = made);
  const {codec} = made;
  await page.goto(ORIGIN);
  assert(await page.evaluate(() => isSecureContext), 'The page is not a secure context.');
  const row = (name, extra) => report.cases.push({name, ...extra});
  const isJxl = bytes => bytes && (bytes[0] === 0xff && bytes[1] === 0x0a || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 12));
  const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
  const photo = new Uint8Array(await readFile(join(fixtures, 'photo.jpg')));
  const gif = new Uint8Array(await readFile(join(fixtures, 'two-frames.gif')));
  const mp4 = new Uint8Array(await readFile(join(fixtures, 'train.mp4')));
  const timed = async (name, call) => { const t0 = Date.now(); const value = await call(); report.ms = {...report.ms, [name]: Date.now() - t0}; return value; };

  let result = await timed('encode', () => codec.encode(photo));
  assert(isJxl(result)); row('encode-e3-q80', {bytes: result.length, input: photo.length});
  result = await codec.encodeExact(photo); assert(isJxl(result)); row('encode-exact', {bytes: result.length});
  const jxl = await timed('recompress', () => codec.recompress(photo));
  assert(jxl.length < photo.length);
  const restored = await codec.restore(jxl);
  assert(same(restored, photo), 'restore did not give the same JPEG.'); row('jpeg-restore', {jxlBytes: jxl.length, identical: true});

  const {decode} = await import(pathToFileURL(join(packageDir, 'dist/decode.mjs')).href);
  result = await timed('gif', () => codec.animate(gif));
  assert(isJxl(result));
  const shown = await decode(result);
  assert.equal(shown.frames.length, 2);
  [0.1, 0.08].forEach((want, i) => assert(Math.abs(shown.frames[i].durationSeconds - want) < 1e-3, `frame ${i} delay ${shown.frames[i].durationSeconds}`));
  row('gif-animate', {bytes: result.length, frames: 2});

  if (process.env.RN_CHECK_VIDEO !== '0') {
    const fractions = [];
    result = await timed('video', () => codec.animate(mp4, {effort: 1, onProgress: f => fractions.push(f)}));
    const clip = await decode(result), seconds = clip.frames.reduce((sum, f) => sum + f.durationSeconds, 0);
    assert(clip.frames.length > 1 && Math.abs(seconds - 2) < 0.1, `${clip.frames.length} frames, ${seconds} s`);
    assert(fractions.length > 0 && fractions.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= fractions[i - 1])));
    row('video-animate', {input: mp4.length, bytes: result.length, frames: clip.frames.length, seconds: +seconds.toFixed(3)});
    const controller = new AbortController();
    const canceled = codec.animate(mp4, {effort: 3, signal: controller.signal, onProgress: () => controller.abort()});
    await assert.rejects(canceled, error => error instanceof JXLError && error.code === 'JXL_CANCELED');
    row('video-cancel', {code: 'JXL_CANCELED'});
  }

  await assert.rejects(codec.recompress(new Uint8Array([0, 1, 2])), error => error instanceof JXLError && /^JXL_[A-Z0-9_]+$/.test(error.code));
  row('bad-input', {});
  const stop = new AbortController();
  const pending = codec.encodeExact(photo, {signal: stop.signal});
  stop.abort();
  await assert.rejects(pending, error => error.code === 'JXL_CANCELED');
  row('cancel', {code: 'JXL_CANCELED'});
  const early = new AbortController(); early.abort();
  await assert.rejects(codec.encode(photo, {signal: early.signal}), error => error.code === 'JXL_CANCELED');
  const [a, b] = await Promise.all([codec.encode(photo, {quality: 60, effort: 1}), codec.encode(photo, {quality: 90, effort: 1})]);
  assert(isJxl(a) && isJxl(b) && a.length < b.length); row('after-cancel-and-two-at-once', {bytes: [a.length, b.length]});

  assert.deepEqual(outside, [], 'A request left the page.');
  assert.deepEqual(pageErrors, []);
  report.loaded = loaded; report.bridgeCharacters = sentBytes; report.consoleErrors = consoleErrors.length;
  report.status = 'PASS';
} catch (error) {
  report.error = {code: error.code || error.name, message: error.message};
  process.exitCode = 1;
} finally {
  await browser?.close();
  console.log(JSON.stringify(report, null, 2));
}
