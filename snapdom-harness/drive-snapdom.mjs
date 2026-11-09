// Real Safari (safaridriver): plug-in suite + 32 demos with JXL vs toWebp and identity vs Chromium baselines.
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs'
const base = process.env.CHECK_ORIGIN || 'http://127.0.0.1:8000/'
const wdBase = process.env.WEBDRIVER || 'http://127.0.0.1:4444'
const wd = async (method, path, body) => {
  const r = await fetch(wdBase + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 500))
  return j.value
}
const session = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: process.env.BROWSER_NAME || 'safari' } } })
const id = session.sessionId, caps = session.capabilities
try { await wd('POST', `/session/${id}/window/maximize`, {}) } catch {}
async function goto(url) {
  try { await wd('POST', `/session/${id}/url`, { url: 'about:blank' }) } catch {}
  await wd('POST', `/session/${id}/url`, { url })
}
async function waitResult(timeoutSec = 1200) {
  let got = null
  for (let i = 0; i < timeoutSec; i++) {
    const raw = await wd('POST', `/session/${id}/execute/sync`, { script: 'return window.__result ? JSON.stringify(window.__result) : null', args: [] })
    if (raw) {
      got = raw
      try { if (JSON.parse(raw).done !== false) break } catch { break }
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  return got ? JSON.parse(got) : null
}

const CANVAS_NOTE = 'headless VM, willReadFrequently forced'
const label = r => r && Array.isArray(r.rows) ? { ...r, rows: r.rows.map(x => ({ ...x, canvas: CANVAS_NOTE })) } : r
const out = {
  safari: caps.browserVersion,
  platform: caps.platformName,
  macos: process.env.MACOS_VERSION || null,
  tip: 'plugins-jxl.patch',
  canvas: CANVAS_NOTE,
  plugin: null,
  demos: {},
  identity: {},
  summary: {}
}

try {
  await goto(base + 'plugin.html?files=plugin.jxl.test.js')
  out.plugin = label(await waitResult(900)) || { done: true, error: 'no result', passed: 0, failed: 1, total: 1, rows: [] }

  for (const effort of [3, 5]) {
    await goto(base + `demos.html?effort=${effort}&quality=0.8`)
    out.demos[effort] = label(await waitResult(1800)) || { done: true, error: 'no result', rows: [] }
    const baseRows = JSON.parse(readFileSync(new URL(`./baselines/chromium-e${effort}.json`, import.meta.url), 'utf8'))
    const byChr = Object.fromEntries(baseRows.map(r => [r.name, r]))
    let same = 0, differ = [], missing = []
    for (const r of (out.demos[effort].rows || [])) {
      const c = byChr[r.name]
      if (!c || r.error || !r.sha) { missing.push(r.name); continue }
      if (r.sha === c.sha && r.jxlBytes === c.jxlBytes) same++
      else differ.push({ name: r.name, safari: { bytes: r.jxlBytes, sha: r.sha }, chromium: { bytes: c.jxlBytes, sha: c.sha } })
    }
    out.identity[effort] = { same, differCount: differ.length, missingCount: missing.length, total: (out.demos[effort].rows || []).length, differ: differ.slice(0, 10) }
  }
  out.summary = {
    plugin: `${out.plugin.passed}/${out.plugin.total}`,
    pluginFailed: out.plugin.failed,
    e3: { pages: out.demos[3]?.pages, jxlBytes: out.demos[3]?.jxlBytes, webpBytes: out.demos[3]?.webpBytes, jxlMed: out.demos[3]?.jxlExportMed, webpMed: out.demos[3]?.webpExportMed, identity: out.identity[3] },
    e5: { pages: out.demos[5]?.pages, jxlBytes: out.demos[5]?.jxlBytes, webpBytes: out.demos[5]?.webpBytes, jxlMed: out.demos[5]?.jxlExportMed, webpMed: out.demos[5]?.webpExportMed, identity: out.identity[5] },
  }
} finally {
  await wd('DELETE', `/session/${id}`).catch(() => {})
}

writeFileSync('snapdom-safari-results.json', JSON.stringify(out, null, 2))
const lines = [
  `## SnapDOM jxl plug-in on real Safari ${out.safari} / ${out.macos || out.platform} (${CANVAS_NOTE})`,
  '',
  `Plugin.jxl: ${out.summary.plugin}`,
  `Demos e3: ${out.summary.e3.pages}/32 pages; JXL ${out.summary.e3.jxlBytes} B / WebP ${out.summary.e3.webpBytes} B; med ${out.summary.e3.jxlMed} ms JXL vs ${out.summary.e3.webpMed} ms toWebp; ≡Chromium ${out.identity[3]?.same}/${out.identity[3]?.total}`,
  `Demos e5: ${out.summary.e5.pages}/32 pages; JXL ${out.summary.e5.jxlBytes} B / WebP ${out.summary.e5.webpBytes} B; med ${out.summary.e5.jxlMed} ms JXL vs ${out.summary.e5.webpMed} ms toWebp; ≡Chromium ${out.identity[5]?.same}/${out.identity[5]?.total}`,
]
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
console.log(lines.join('\n'))
if ((out.plugin.failed || 0) > 0) process.exitCode = 1
