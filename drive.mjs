// SPDX-License-Identifier: MIT
// Drives Safari through safaridriver (plain WebDriver HTTP on 127.0.0.1:4444) to the page on 127.0.0.1:8000, waits for its
// result, then to control/capture/p3/stress (when present); writes results.json and the job summary; exits 1 when anything fails.
// Pages may heartbeat window.__result with done:false; visit waits until done !== false (done:true, or legacy with no done
// key) or the 300s budget (keeps last partial so a hang names its step via `at`).
// Harness: about:blank interstitial between pages; maximize window; if control's wrf:getImageData fails, skip capture+p3
// (canvas-read death already proven; saves the 300s hung budget) and still run stress (decode-only lane).
import {writeFileSync, appendFileSync, existsSync} from 'node:fs';
const wd = async (method, path, body) => { const r = await fetch('http://127.0.0.1:4444' + path, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)}); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 500)); return j.value; };
const session = await wd('POST', '/session', {capabilities: {alwaysMatch: {browserName: 'safari'}}});
const id = session.sessionId, caps = session.capabilities;
try { await wd('POST', `/session/${id}/window/maximize`, {}); } catch {}
try { await wd('POST', `/session/${id}/window/rect`, {x: 0, y: 0, width: 1280, height: 900}); } catch {}
async function blank() {
  try { await wd('POST', `/session/${id}/url`, {url: 'about:blank'}); } catch {}
}
async function visit(page) {
  let got = null;
  await blank();
  await wd('POST', `/session/${id}/url`, {url: 'http://127.0.0.1:8000/' + page});
  for (let i = 0; i < 300; i++) {
    const raw = await wd('POST', `/session/${id}/execute/sync`, {script: 'return window.__result ? JSON.stringify(window.__result) : null', args: []});
    if (raw) {
      got = raw;
      try {
        // done:false = heartbeat, keep waiting; done:true or missing done (legacy check.mjs) = finished
        if (JSON.parse(raw).done !== false) break;
      } catch { break; }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return got;
}
let result = null, captured = null; const extras = {};
const harness = {skipped: [], aboutBlank: true, maximize: true};
try {
  result = await visit('index.html');
  // control.html first so a capture hang still leaves a diagnosis table
  const order = ['control.html', 'capture.html', 'p3.html', 'stress.html'];
  for (const extra of order) {
    if (!existsSync(extra)) continue;
    if (harness.skipCapture && (extra === 'capture.html' || extra === 'p3.html')) {
      harness.skipped.push(extra);
      extras[extra] = {done: true, at: 'skipped', steps: [{name: 'skipped', pass: false, error: 'skipped: control wrf:getImageData failed'}]};
      captured = captured || {steps: []};
      captured.steps.push({name: extra + ': skipped', pass: false, error: 'control wrf:getImageData failed'});
      continue;
    }
    const fallback = '{"done":true,"steps":[{"name":"' + extra + '","pass":false,"error":"no result"}]}';
    const r = JSON.parse(await visit(extra) || fallback);
    extras[extra] = r;
    captured = captured || {steps: []};
    captured.steps.push(...(r.steps || []).map(s => ({...s, name: extra + ': ' + s.name})));
    if (r.platform && !captured.platform) captured.platform = r.platform;
    if (r.at && r.done === false) captured.steps.push({name: extra + ': hung-at', pass: false, error: String(r.at)});
    if (extra === 'control.html') {
      const wrf = (r.steps || []).find(s => s.name === 'wrf: getImageData');
      harness.controlWrfGetImageData = wrf ? {pass: !!wrf.pass, error: wrf.error || null} : {pass: false, error: 'missing step'};
      harness.skipCapture = !harness.controlWrfGetImageData.pass;
      const bare = (r.steps || []).find(s => s.name === 'bare: getImageData');
      harness.controlBareGetImageData = bare ? {pass: !!bare.pass, error: bare.error || null} : null;
    }
  }
} finally { await wd('DELETE', `/session/${id}`).catch(() => {}); }
if (!result) throw new Error('the page gave no result');
const out = {safari: caps.browserVersion, platform: caps.platformName, macos: process.env.MACOS_VERSION, ...JSON.parse(result), capture: captured, extras, harness};
writeFileSync('results.json', JSON.stringify(out, null, 1));
const failed = [...out.results.filter(r => r.verdict !== 'pass'), ...(captured?.steps || []).filter(s => !s.pass)];
const cell = c => !c ? '' : c.error ? c.error : `worst ${c.worst}, alpha ${c.alphaWorst}${c.over ? `, ${c.over} px over` : ''}${c.exactWrong ? `, ${c.exactWrong} exact px wrong` : ''}`;
const lines = [`## Safari ${out.safari}, macOS ${out.macos}, native JPEG XL: ${out.nativeJXL}`, '', `${out.results.filter(r => r.verdict === 'pass').length}/${out.results.length} files pass (verdict: createImageBitmap without color conversion; <img> reported)`, '',
  '| file | kind | tolerance | bitmap | img | verdict |', '|---|---|---|---|---|---|',
  ...out.results.map(r => `| ${r.id} | ${r.kind} | ${r.tolerance ?? ''} | ${cell(r.bitmap)} | ${cell(r.img)} | ${r.verdict}${r.error ? ' ' + r.error : ''} |`)];
if (captured) lines.push('', `## Capture in Safari (package ${process.env.PKG_VERSION || ''}): ${JSON.stringify(captured.platform || {})}`, '',
  `Harness: blank=${harness.aboutBlank}, maximize, skipCapture=${!!harness.skipCapture}, bare=${JSON.stringify(harness.controlBareGetImageData)}, wrf=${JSON.stringify(harness.controlWrfGetImageData)}, skipped=${harness.skipped.join(',') || 'none'}`, '',
  '| step | result |', '|---|---|',
  ...captured.steps.map(s => `| ${s.name} | ${s.skipped ? 'skipped: ' + s.skipped : s.pass ? `pass, ${s.bytes} B${s.exactBytes ? `, exact ${s.exactBytes} B` : ''}${s.width ? `, ${s.width}x${s.height}` : ''}` : `FAIL ${s.code || ''} ${s.error || ''} ${s.stack || ''}`} |`));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exitCode = failed.length ? 1 : 0;
