// Real Safari (safaridriver): plug-in suite + 32 demos with JXL vs toWebp and identity vs Chromium baselines.
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
const base = process.env.CHECK_ORIGIN || 'http://127.0.0.1:8000/'
const wdBase = process.env.WEBDRIVER || 'http://127.0.0.1:4444'
const wd = async (method, path, body) => {
  const r = await fetch(wdBase + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 500))
  return j.value
}
let session
for (let attempt = 1; attempt <= 3; attempt++) {
  try { session = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: process.env.BROWSER_NAME || 'safari' } } }); break }
  catch (error) { if (attempt === 3) throw error; console.error('session attempt ' + attempt + ': ' + String(error.message).slice(0, 200)); await new Promise(r => setTimeout(r, 20000)) }
}
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
// The package under test: what the server serves (RAPIER_JXL), by its tarball digest; the
// candidate's package.json can still carry the last published version.
const jxlDir = process.env.RAPIER_JXL || new URL('../p/cand/package', import.meta.url).pathname
const tgzSha = (() => { try { return readFileSync(new URL('../rapier-jxl-candidate.tgz.sha256', import.meta.url), 'utf8').split(/\s+/)[0] } catch { return null } })()
const out = {
  safari: caps.browserVersion,
  package: { dir: jxlDir, version: JSON.parse(readFileSync(jxlDir + '/package.json', 'utf8')).version, tgzSha256: tgzSha },
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

  for (const effort of [3, 5, 7]) {
    await goto(base + `demos.html?effort=${effort}&quality=0.8`)
    out.demos[effort] = label(await waitResult(1800)) || { done: true, error: 'no result', rows: [] }
    const baseFile = new URL(`./baselines/chromium-e${effort}.json`, import.meta.url); if (!existsSync(baseFile)) continue
    const baseRows = JSON.parse(readFileSync(baseFile, 'utf8'))
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
  `rapier-jxl served: ${out.package.dir} (package.json ${out.package.version}, candidate tgz sha256 ${out.package.tgzSha256})`,
]
const probe = out.plugin?.probe
if (probe) {
  lines.push('', `Boundary (no SnapDOM) env: ${JSON.stringify(probe.env)}`)
  for (const [k, v] of Object.entries(probe.rows || {})) lines.push(`- ${k}: ${JSON.stringify(v).slice(0, 700)}`)
}
for (const r of (out.plugin?.inputs || []).slice(0, 3)) lines.push(`- plug-in capture() input: ${JSON.stringify(r).slice(0, 900)}`)
const d3 = (out.demos[3]?.rows || []).find(r => r.inputs)
if (d3) lines.push(`- demo e3 ${d3.name} capture() input: ${JSON.stringify(d3.inputs[0]).slice(0, 900)}`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
console.log(lines.join('\n'))
if ((out.plugin.failed || 0) > 0) process.exitCode = 1
