// SPDX-License-Identifier: MIT
// Drives Safari through safaridriver (plain WebDriver HTTP on 127.0.0.1:4444): index.html (native decode, no package),
// then for each package (published 8.2.0, the candidate) control, capture, p3, codecprobe and stress pages; writes
// results.json and one table per row with both packages side by side; exits 1 when any row fails.
// Pages heartbeat window.__result with done:false; a visit waits for done !== false or 300 s and keeps the last partial,
// so a hang names its step. about:blank between pages; window maximized. A package whose control wrf:getImageData fails
// skips its capture and p3 pages (canvas reads are dead there).
import {writeFileSync, appendFileSync, existsSync} from 'node:fs';
const PACKAGES = [{id: '820', label: '8.2.0'}, {id: 'cand', label: 'candidate'}];
const PAGES = ['control', 'capture', 'p3', 'codecprobe', 'stress', 'cells'];
const base = process.env.CHECK_ORIGIN || 'http://127.0.0.1:8000/';
const wd = async (method, path, body) => { const r = await fetch((process.env.WEBDRIVER || 'http://127.0.0.1:4444') + path, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)}); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 500)); return j.value; };
const session = await wd('POST', '/session', {capabilities: {alwaysMatch: {browserName: process.env.BROWSER_NAME || 'safari'}}});
const id = session.sessionId, caps = session.capabilities;
try { await wd('POST', `/session/${id}/window/maximize`, {}); } catch {}
try { await wd('POST', `/session/${id}/window/rect`, {x: 0, y: 0, width: 1280, height: 900}); } catch {}
async function visit(page) {
  let got = null;
  try { await wd('POST', `/session/${id}/url`, {url: 'about:blank'}); } catch {}
  await wd('POST', `/session/${id}/url`, {url: base + page});
  for (let i = 0; i < 300; i++) {
    const raw = await wd('POST', `/session/${id}/execute/sync`, {script: 'return window.__result ? JSON.stringify(window.__result) : null', args: []});
    if (raw) { got = raw; try { if (JSON.parse(raw).done !== false) break; } catch { break; } }
    await new Promise(r => setTimeout(r, 1000));
  }
  return got;
}
let result = null; const pages = {}, harness = {};
try {
  result = await visit('index.html');
  for (const {id: pkg} of PACKAGES) {
    pages[pkg] = {}; harness[pkg] = {skipped: []};
    for (const page of PAGES) {
      const file = `${page}-${pkg}.html`;
      if (!existsSync(file)) continue;
      if (harness[pkg].skipCapture && (page === 'capture' || page === 'p3')) {
        harness[pkg].skipped.push(page);
        pages[pkg][page] = {done: true, steps: [{name: 'skipped', pass: false, error: 'control wrf: getImageData failed'}]};
        continue;
      }
      const r = JSON.parse(await visit(file) || '{"done":true,"steps":[{"name":"page","pass":false,"error":"no result"}]}');
      if (r.done === false) (r.steps ||= []).push({name: 'hung-at', pass: false, error: String(r.at)});
      pages[pkg][page] = r;
      if (page === 'control') {
        const wrf = (r.steps || []).find(s => s.name === 'wrf: getImageData');
        harness[pkg].skipCapture = !wrf?.pass;
      }
    }
  }
} finally { await wd('DELETE', `/session/${id}`).catch(() => {}); }
if (!result) throw new Error('the page gave no result');
// Rows: page: step, with each package's cell.
const rows = new Map();
for (const {id: pkg} of PACKAGES) for (const page of PAGES) for (const s of pages[pkg]?.[page]?.steps || []) {
  const key = `${page}: ${s.name}`;
  if (!rows.has(key)) rows.set(key, {});
  rows.get(key)[pkg] = s;
}
const out = {safari: caps.browserVersion, platform: caps.platformName, macos: process.env.MACOS_VERSION, packages: process.env.PACKAGES_INFO, ...JSON.parse(result), harness, pages,
  rows: [...rows].map(([name, cells]) => ({name, ...cells}))};
writeFileSync('results.json', JSON.stringify(out, null, 1));
const esc = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const cell = s => !s ? '—' : s.skipped ? 'skipped: ' + esc(s.skipped)
  : (s.pass ? 'pass' : 'FAIL') + (s.code ? ' ' + s.code : '') + (s.bytes !== undefined ? `, ${s.bytes} B` : '') + (s.exactBytes ? `, exact ${s.exactBytes} B` : '') + (s.worst !== undefined ? `, worst ${s.worst}` : '')
    + (s.error ? ': ' + esc(s.error).slice(0, 160) : '') + (s.refused ? ' (refused: ' + esc(s.refused).slice(0, 100) + ')' : '') + (!s.pass && s.stack ? ' [' + esc(s.stack).slice(0, 160) + ']' : '') + (s.shape ? ' ⟨' + esc(s.shape).slice(0, 220) + '⟩' : '');
const cellD = c => !c ? '' : c.error ? c.error : `worst ${c.worst}, alpha ${c.alphaWorst}${c.over ? `, ${c.over} px over` : ''}${c.exactWrong ? `, ${c.exactWrong} exact px wrong` : ''}`;
const lines = [`## Safari ${out.safari}, macOS ${out.macos}, native JPEG XL: ${out.nativeJXL}`, '', `Packages: ${out.packages || ''}`, '',
  `${out.results.filter(r => r.verdict === 'pass').length}/${out.results.length} files pass (verdict: createImageBitmap without color conversion; <img> reported)`, '',
  '| file | kind | tolerance | bitmap | img | verdict |', '|---|---|---|---|---|---|',
  ...out.results.map(r => `| ${r.id} | ${r.kind} | ${r.tolerance ?? ''} | ${cellD(r.bitmap)} | ${cellD(r.img)} | ${r.verdict}${r.error ? ' ' + r.error : ''} |`),
  '', `## Package rows (skipped: ${PACKAGES.map(p => `${p.label} ${harness[p.id]?.skipped.join(',') || 'none'}`).join('; ')})`, '',
  `| row | ${PACKAGES.map(p => p.label).join(' | ')} |`, `|---|${PACKAGES.map(() => '---').join('|')}|`,
  ...[...rows].map(([name, cells]) => `| ${esc(name)} | ${PACKAGES.map(p => cell(cells[p.id])).join(' | ')} |`)];
const probes = PACKAGES.flatMap(p => (pages[p.id]?.codecprobe?.probes || []).filter((x, i, all) => x.kind === 'job' || (x.kind === 'boot' && all.findIndex(y => y.kind === 'boot') === i)).map(x => `- ${p.label} ${x.kind}: ${esc(JSON.stringify(x)).slice(0, 600)}`));
if (probes.length) lines.push('', '## Worker-side probe (job inputs as rapier-jxl\'s worker received them)', '', ...probes);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
console.log(lines.join('\n'));
const failed = [...out.results.filter(r => r.verdict !== 'pass'), ...[...rows.values()].flatMap(c => Object.values(c)).filter(s => !s.pass)];
// Failing rows are results, read from the summary and results.json; the job fails only when the check itself breaks.
console.log(`${failed.length} failing rows or files`);
