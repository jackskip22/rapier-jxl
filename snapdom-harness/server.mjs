import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
const root = new URL('..', import.meta.url).pathname
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.gif': 'image/gif', '.webp': 'image/webp', '.wasm': 'application/wasm' }
const jxlDir = process.env.RAPIER_JXL || join(root, 'p/cand/package')
const snapdomDir = process.env.SNAPDOM || join(root, 'snapdom')
const jxlPkg = JSON.parse(readFileSync(join(jxlDir, 'package.json'), 'utf8'))
const pick = v => typeof v === 'string' ? v : v && (pick(v.browser) || pick(v.import) || pick(v.default))
const jxlImports = {}
for (const [k, v] of Object.entries(jxlPkg.exports)) {
  const t = pick(v); if (t && /\.m?js$/.test(t)) jxlImports[k.replace(/^\./, 'rapier-jxl')] = '/rapier-jxl/' + t.replace(/^\.\//, '')
}
const shimTag = '<script src="/snapdom-harness/canvas-shim.js"></script>'
const mapTag = () => shimTag + `<script type="importmap">${JSON.stringify({ imports: { ...jxlImports, vitest: '/snapdom-harness/vitest-shim.js', '@zumer/snapdom': '/snapdom/src/index.js' } })}</script>`
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  try {
    if (path === '/demo-list') {
      const dir = join(snapdomDir, 'demos')
      const out = []
      for (const name of (await readdir(dir)).filter(n => /^d.*\.html$/.test(n)).sort()) {
        const html = await readFile(join(dir, name), 'utf8')
        if (/id=["']target["']/.test(html) && !/https?:\/\//.test(html)) out.push(name)
      }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out))
    }
    if (path === '/plugin.html' || path.startsWith('/plugin.html')) {
      const html = await readFile(join(root, 'snapdom-harness/plugin.html'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html.replace('<!--IMPORTMAP-->', mapTag()))
    }
    if (path === '/demos.html' || path.startsWith('/demos.html')) {
      const html = await readFile(join(root, 'snapdom-harness/demos.html'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html.replace('<!--IMPORTMAP-->', mapTag()))
    }
    let file
    if (path.startsWith('/rapier-jxl/')) file = join(jxlDir, path.slice('/rapier-jxl/'.length))
    else if (path.startsWith('/snapdom-harness/')) file = join(root, path.slice(1))
    else if (path.startsWith('/snapdom/')) file = join(snapdomDir, path.slice('/snapdom/'.length))
    else {
      // The SnapDOM suite uses root paths (/demos/..., /__tests__/...) relative to its own tree.
      file = join(root, path.slice(1))
      if (!existsSync(file) && existsSync(join(snapdomDir, path.slice(1)))) file = join(snapdomDir, path.slice(1))
    }
    if (!extname(path)) {
      if (existsSync(file + '.js')) file += '.js'
      else if (existsSync(join(file, 'index.js'))) { res.writeHead(302, { location: path + '/index.js' }); return res.end() }
    }
    let body = await readFile(file)
    if (file.endsWith('.html')) body = Buffer.from(String(body).replace(/<head[^>]*>/i, m => m + mapTag()))
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch (e) {
    res.writeHead(404); res.end(String(e.message))
  }
})
const port = +(process.env.PORT || 8000)
server.listen(port, '127.0.0.1', () => console.log('listening', port, 'jxl', jxlDir))
