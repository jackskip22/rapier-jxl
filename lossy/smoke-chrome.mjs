#!/usr/bin/env node
/**
 * Local Chrome headless smoke for the Safari lossy-row check (not Safari).
 * Usage: node smoke-chrome.mjs [--port 8799]
 * Always runs subset=24. Kills only the Chrome PID it starts.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const args = process.argv.slice(2);
const portArg = args.find((a, i) => args[i - 1] === '--port') || '8799';
const PORT = Number(portArg);
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.jxl': 'image/jxl',
  '.wasm': 'application/wasm',
};

let resolveSmoke;
const pending = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('smoke timeout 10m')), 10 * 60 * 1000);
  resolveSmoke = (v) => { clearTimeout(t); resolve(v); };
});

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'POST' && u.pathname === '/results') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let report;
      try { report = JSON.parse(body); } catch (e) { report = { parseError: String(e), body: body.slice(0, 200) }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      resolveSmoke(report);
    });
    return;
  }
  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, p);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-opener-policy': 'same-origin',
  });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((r, j) => server.listen(PORT, '127.0.0.1', r).on('error', j));
const profile = fs.mkdtempSync('/tmp/safari-lossy-smoke-');
const url = `http://127.0.0.1:${PORT}/index.html?subset=24&smoke=1`;
console.error('serving', ROOT, url);

const child = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  url,
], { stdio: ['ignore', 'pipe', 'pipe'] });
console.error('chrome pid', child.pid);
child.stdout.on('data', d => process.stderr.write(`[c:out] ${d}`));
child.stderr.on('data', d => process.stderr.write(`[c:err] ${d}`));

let report;
try {
  report = await pending;
} finally {
  try { child.kill('SIGTERM'); } catch {}
  await new Promise(r => setTimeout(r, 600));
  try { child.kill('SIGKILL'); } catch {}
  server.close();
}

fs.writeFileSync(path.join(ROOT, 'smoke-chrome-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report?.summary || report, null, 2));
if (!report?.done || report?.fatal) process.exit(1);
if ((report.summary?.pageOk || 0) < 1) {
  console.error('no page ok rows');
  process.exit(1);
}
console.error('smoke OK');
