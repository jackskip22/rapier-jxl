// Runs a scenario in the built app's own web view: a dropped photo, a chosen JPEG's round trip, a video, cancel, a refusal, and
// Save (the check build writes the file where this test says, with no dialog). The files are read back here with the package's
// decoder. Linux and Windows are driven through tauri-driver (WebKitWebDriver, msedgedriver); macOS has no WebDriver for WKWebView,
// so there the check build runs the same scenario itself (`TAURI_CHECK=direct`, the default on macOS).
// cd examples/tauri && npm install && JXL_PACKAGE=/built/package npm run assets && npm run build && npm run check
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../desktop/fixtures');
const pkg = resolve(process.env.JXL_PACKAGE ?? join(here, 'node_modules/jpegxl'));
const exe = process.platform === 'win32' ? '.exe' : '';
const target = process.env.CARGO_TARGET_DIR ?? join(here, 'src-tauri/target');
const application = process.env.TAURI_APP ?? ['debug', 'release'].map(kind => join(target, kind, `rapier-jxl-tauri-example${exe}`)).find(existsSync);
assert(application, 'Build the app first: npm run build.');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = await import(pathToFileURL(join(pkg, 'dist/decode.mjs')).href);
const {restore} = await import(pathToFileURL(join(pkg, 'dist/jpeg.node.mjs')).href);
const b64 = async name => (await readFile(join(fixtures, name))).toString('base64');
const out = await mkdtemp(join(tmpdir(), 'jxl-tauri-'));
const report = {status: 'FAIL'};
const direct = (process.env.TAURI_CHECK ?? (process.platform === 'darwin' ? 'direct' : 'driver')) === 'direct';
const driver = direct ? null : spawn('tauri-driver', process.env.TAURI_NATIVE_DRIVER ? ['--native-driver', process.env.TAURI_NATIVE_DRIVER] : [], {stdio: ['ignore', 'inherit', 'inherit'], env: {...process.env, RAPIER_JXL_CHECK_SAVE_DIR: out}});
const base = 'http://127.0.0.1:4444';
const call = async (method, path, body) => {
  const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json'}, body: body && JSON.stringify(body)});
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
  return json.value;
};
let session;
try {
  for (let tries = 0; !direct; tries++) { try { await fetch(base + '/status'); break; } catch { if (tries > 50) throw new Error('tauri-driver did not start.'); await new Promise(r => setTimeout(r, 200)); } }
  // The scenario runs in the page, where a drop and a change event are the same as a person's.
  const scenario0 = async (photo, jpeg, videos) => {
    const $ = id => document.getElementById(id), status = () => $('status').value;
    const settled = async () => { for (let i = 0; i < 1200; i++) { if (!$('photo').disabled && /bytes from|^JXL_/.test(status())) return status(); await new Promise(r => setTimeout(r, 100)); } throw new Error('Timed out: ' + status()); };
    const file = (name, type, base64) => new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, {type});
    const drop = f => { const t = new DataTransfer(); t.items.add(f); const e = new Event('drop', {bubbles: true, cancelable: true}); Object.defineProperty(e, 'dataTransfer', {value: t}); dispatchEvent(e); };
    const choose = (id, f) => { const t = new DataTransfer(); t.items.add(f); $(id).files = t.files; $(id).dispatchEvent(new Event('change')); };
    const save = async () => {
      $('save').click();
      for (let i = 0; i < 100 && !/^(Saved |JXL_SAVE)/.test(status()); i++) await new Promise(r => setTimeout(r, 100));
      return status();
    };
    const log = {};
    try {
    while (document.readyState !== 'complete') await new Promise(r => setTimeout(r, 50));
    log.isolated = crossOriginIsolated; log.origin = location.origin; log.userAgent = navigator.userAgent;
    log.mp4 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'); log.webm = document.createElement('video').canPlayType('video/webm; codecs="vp8"');
    drop(file('photo.jpg', 'image/jpeg', photo)); log.photo = await settled(); log.photoSave = await save();
    choose('jpeg-file', file('photo-jpeg.jpg', 'image/jpeg', jpeg)); log.jpeg = await settled(); log.jpegSave = await save();
    const video = log.mp4 ? ['train.mp4', 'video/mp4', videos.mp4] : ['train.webm', 'video/webm', videos.webm];
    log.videoType = video[1]; drop(file(...video)); log.video = await settled(); log.videoSave = await save();
    choose('video-file', file(...video));
    for (let i = 0; i < 100 && $('cancel').disabled; i++) await new Promise(r => setTimeout(r, 20));
    $('cancel').click(); log.cancel = await settled(); log.cancelSaveDisabled = $('save').disabled;
    drop(file('photo.jpg', 'image/jpeg', photo)); log.afterCancel = await settled();
    choose('jpeg-file', file('broken.jpg', 'image/jpeg', btoa('not a JPEG'))); log.bad = await settled(); log.badSaveDisabled = $('save').disabled;
    } catch (error) { log.failed = `${error?.name}: ${error?.message || error} ${error?.stack || ''} | ${$('status').value}`; }
    return log;
  };
  const args = [await b64('photo.jpg'), await b64('photo.jpg'), {mp4: await b64('train.mp4'), webm: await b64('train.webm')}];
  let log;
  if (direct) {
    const script = join(out, 'run.js');
    await writeFile(script, `(${scenario0.toString()})(...${JSON.stringify(args)}).then(log => __TAURI__.core.invoke('check_report', {json: JSON.stringify(log)}), error => __TAURI__.core.invoke('check_report', {json: JSON.stringify({failed: String(error)})}));`);
    const app = spawn(application, [], {stdio: 'inherit', env: {...process.env, RAPIER_JXL_CHECK_SAVE_DIR: out, RAPIER_JXL_CHECK_SCRIPT: script}});
    const code = await new Promise(resolve => { const timer = setTimeout(() => { app.kill(); resolve('timeout'); }, 600000); app.on('exit', c => { clearTimeout(timer); resolve(c); }); });
    log = JSON.parse(await readFile(join(out, 'report.json'), 'utf8').catch(() => JSON.stringify({failed: `The app ended (${code}) without a report.`})));
  } else {
    ({sessionId: session} = await call('POST', '/session', {capabilities: {alwaysMatch: {browserName: 'wry', 'tauri:options': {application}}}}));
    await call('POST', `/session/${session}/timeouts`, {script: 600000});
    log = await call('POST', `/session/${session}/execute/async`, {
      script: `const done = arguments[arguments.length - 1]; (${scenario0.toString()})(...arguments[0]).then(done, error => done({failed: String(error && error.message || error)}));`, args: [args]
    });
  }
  report.log = log;
  assert(!log.failed, JSON.stringify(log));
  const photo = await readFile(join(fixtures, 'photo.jpg'));
  assert.match(log.photo, /bytes from/); assert.match(log.photoSave, /^Saved /);
  const still = await decoder.decode(new Uint8Array(await readFile(join(out, 'photo.jxl'))));
  assert(still.width === 640 && still.height === 427, `${still.width}x${still.height}`);
  assert(log.jpeg.includes(`same file: ${sha256(photo)}`), log.jpeg);
  assert.equal(sha256((await restore(new Uint8Array(await readFile(join(out, 'photo-jpeg.jxl'))))).bytes), sha256(photo));
  const clip = await decoder.decode(new Uint8Array(await readFile(join(out, 'train.jxl'))));
  const seconds = clip.frames.reduce((sum, frame) => sum + frame.durationSeconds, 0);
  assert(clip.frames.length > 1 && Math.abs(seconds - 2) < 0.1, `${clip.frames.length} frames, ${seconds} s`);
  assert.match(log.cancel, /^JXL_CANCELED/); assert(log.cancelSaveDisabled);
  assert.match(log.afterCancel, /bytes from/);
  assert.match(log.bad, /^JXL_[A-Z0-9_]+:/); assert(log.badSaveDisabled);
  report.status = 'PASS'; report.engine = {origin: log.origin, userAgent: log.userAgent, isolated: log.isolated}; report.video = {type: log.videoType, frames: clip.frames.length, seconds: +seconds.toFixed(3)};
} catch (error) {
  report.error = {code: error.code || error.name, message: error.message}; process.exitCode = 1;
} finally {
  if (session) await call('DELETE', `/session/${session}`).catch(() => {});
  driver?.kill(); await rm(out, {recursive: true, force: true});
  console.log(JSON.stringify(report, null, 2));
}
