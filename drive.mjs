// SPDX-License-Identifier: MIT
// Drives Safari through safaridriver (plain WebDriver HTTP on 127.0.0.1:4444) to the page on 127.0.0.1:8000, waits for its
// result, then to capture.html (when present); writes results.json and the job summary; exits 1 when anything fails.
import {writeFileSync, appendFileSync, existsSync} from 'node:fs';
const wd = async (method, path, body) => { const r = await fetch('http://127.0.0.1:4444' + path, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)}); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 500)); return j.value; };
const session = await wd('POST', '/session', {capabilities: {alwaysMatch: {browserName: 'safari'}}});
const id = session.sessionId, caps = session.capabilities;
async function visit(page) {
  let got = null;
  await wd('POST', `/session/${id}/url`, {url: 'http://127.0.0.1:8000/' + page});
  for (let i = 0; i < 300 && !got; i++) { got = await wd('POST', `/session/${id}/execute/sync`, {script: 'return window.__result ? JSON.stringify(window.__result) : null', args: []}); if (!got) await new Promise(r => setTimeout(r, 1000)); }
  return got;
}
let result = null, captured = null; const extras = {};
try {
  result = await visit('index.html');
  if (existsSync('capture.html')) captured = JSON.parse(await visit('capture.html') || '{"steps":[{"name":"capture page","pass":false,"error":"no result"}]}');
  for (const extra of ['p3.html', 'stress.html']) if (existsSync(extra)) { const r = JSON.parse(await visit(extra) || '{"steps":[{"name":"' + extra + '","pass":false,"error":"no result"}]}'); extras[extra] = r; captured = captured || {steps: []}; captured.steps.push(...r.steps.map(s => ({...s, name: extra + ': ' + s.name}))); }
} finally { await wd('DELETE', `/session/${id}`).catch(() => {}); }
if (!result) throw new Error('the page gave no result');
const out = {safari: caps.browserVersion, platform: caps.platformName, macos: process.env.MACOS_VERSION, ...JSON.parse(result), capture: captured, extras};
writeFileSync('results.json', JSON.stringify(out, null, 1));
const failed = [...out.results.filter(r => r.verdict !== 'pass'), ...(captured?.steps || []).filter(s => !s.pass)];
const cell = c => !c ? '' : c.error ? c.error : `worst ${c.worst}, alpha ${c.alphaWorst}${c.over ? `, ${c.over} px over` : ''}${c.exactWrong ? `, ${c.exactWrong} exact px wrong` : ''}`;
const lines = [`## Safari ${out.safari}, macOS ${out.macos}, native JPEG XL: ${out.nativeJXL}`, '', `${out.results.filter(r => r.verdict === 'pass').length}/${out.results.length} files pass (verdict: createImageBitmap without color conversion; <img> reported)`, '',
  '| file | kind | tolerance | bitmap | img | verdict |', '|---|---|---|---|---|---|',
  ...out.results.map(r => `| ${r.id} | ${r.kind} | ${r.tolerance ?? ''} | ${cell(r.bitmap)} | ${cell(r.img)} | ${r.verdict}${r.error ? ' ' + r.error : ''} |`)];
if (captured) lines.push('', `## Capture in Safari (package ${process.env.PKG_VERSION || ''}): ${JSON.stringify(captured.platform)}`, '', '| step | result |', '|---|---|',
  ...captured.steps.map(s => `| ${s.name} | ${s.skipped ? 'skipped: ' + s.skipped : s.pass ? `pass, ${s.bytes} B${s.exactBytes ? `, exact ${s.exactBytes} B` : ''}` : `FAIL ${s.code || ''} ${s.error || ''} ${s.stack || ''}`} |`));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exitCode = failed.length ? 1 : 0;
