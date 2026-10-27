import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function serve({ root = fileURLToPath(new URL('../../', import.meta.url)), port = 0 } = {}) {
  root = resolve(root);
  const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.png': 'image/png', '.jxl': 'image/jxl', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
      if (!path.startsWith(`${root}${sep}`)) throw new Error('outside root');
      const data = await readFile(path);
      response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(data);
    } catch {
      response.writeHead(404); response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await serve({ port: Number(process.env.PORT || 8787) });
  console.log(`${url}/examples/snapdom/index.html`);
}
