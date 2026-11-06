// SPDX-License-Identifier: MIT
// Drives Safari (safaridriver) or any WebDriver for the lossy native-decode rows page.
// Usage: SUBSET=24 node drive.mjs   # 24-file subset; omit for all 144
import { writeFileSync, appendFileSync } from 'node:fs';

const subset = process.env.SUBSET === '24' || process.env.SUBSET === 'true';
const base = process.env.CHECK_ORIGIN || 'http://127.0.0.1:8000/';
const page = 'index.html' + (subset ? '?subset=24' : '');
const wd = async (method, path, body) => {
  const r = await fetch((process.env.WEBDRIVER || 'http://127.0.0.1:4444') + path, {
    method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 500));
  return j.value;
};

const session = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: process.env.BROWSER_NAME || 'safari' } } });
const id = session.sessionId, caps = session.capabilities;
try { await wd('POST', `/session/${id}/window/maximize`, {}); } catch {}

let got = null;
try {
  try { await wd('POST', `/session/${id}/url`, { url: 'about:blank' }); } catch {}
  await wd('POST', `/session/${id}/url`, { url: base + page });
  // 144 files × decode can take a while; 25 min cap inside 35 min job
  for (let i = 0; i < 1500; i++) {
    const raw = await wd('POST', `/session/${id}/execute/sync`, {
      script: 'return window.__result ? JSON.stringify(window.__result) : null', args: [],
    });
    if (raw) {
      got = raw;
      try { if (JSON.parse(raw).done === true) break; } catch { break; }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
} finally {
  await wd('DELETE', `/session/${id}`).catch(() => {});
}

if (!got) throw new Error('page gave no result');
const result = JSON.parse(got);
if (result.done !== true) {
  result.hung = true;
  result.hungAt = result.at;
}
writeFileSync('results.json', JSON.stringify(result, null, 1));

const s = result.summary || {};
const lines = [
  `## Safari lossy native-decode rows`,
  '',
  `Safari ${caps.browserVersion || '?'}, platform ${caps.platformName || '?'}, macOS ${process.env.MACOS_VERSION || '?'}`,
  `stems ${result.stemCount}/${result.manifestCount || '?'} (subset=${!!result.subset})`,
  `page ok ${s.pageOk}/${s.total}, worker ok ${s.workerOk}/${s.total}`,
  `page worst maxAbsDiff ${s.pageWorstMaxAbsDiff}, worker worst maxAbsDiff ${s.workerWorstMaxAbsDiff}`,
  '',
  '| stem | page | worker | pageΔ | workerΔ | decoded |',
  '|---|---|---|---|---|---|',
  ...(result.rows || []).map(r => {
    const p = r.page?.ok ? 'ok' : ('FAIL' + (r.page?.error ? ': ' + String(r.page.error).slice(0, 80) : ''));
    const w = r.worker?.ok ? 'ok' : ('FAIL' + (r.worker?.error ? ': ' + String(r.worker.error).slice(0, 80) : ''));
    return `| ${r.stem} | ${p} | ${w} | ${r.pageMaxAbsDiff ?? '—'} | ${r.workerMaxAbsDiff ?? '—'} | ${r.decoded} |`;
  }),
];
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (result.fatal || result.hung || result.done !== true) process.exit(1);
console.log('check completed (row FAILs are reported, not exit-1)');
