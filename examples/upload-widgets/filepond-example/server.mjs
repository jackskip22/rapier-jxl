// node server.mjs [port]: serves this page (http://127.0.0.1:8716/filepond-example/) and the project's node_modules, and receives FilePond's uploads (POST /upload,
// multipart, field "filepond") into ./uploads, as a server that accepts image/jxl would. Each upload is stored under its
// own numbered name, so two files both named photo.jxl are both kept. GET /uploads lists each file's name, stored name,
// type and size. Run it from the project folder where filepond and the package are installed. A local demo on
// 127.0.0.1, not a production server.
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join, extname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const widgets = fileURLToPath(new URL('..', import.meta.url)), project = process.cwd(), port = Number(process.argv[2] ?? 8716);
const TYPES = {'.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm'};
const received = [];

// The one file part of a multipart body: its filename, content type and bytes.
function filePart(body, type) {
  const boundary = Buffer.from('--' + /boundary=(?:"([^"]+)"|([^;]+))/.exec(type)?.slice(1).find(Boolean));
  for (let at = body.indexOf(boundary); at >= 0;) {
    const next = body.indexOf(boundary, at + boundary.length);
    if (next < 0) break;
    const part = body.subarray(at + boundary.length + 2, next - 2), split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString();
    const name = /filename="([^"]*)"/.exec(head)?.[1];
    if (name) return {name, type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? '', bytes: part.subarray(split + 4)};
    at = next;
  }
  return null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://x');
  try {
    if (request.method === 'POST' && url.pathname === '/upload') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const file = filePart(Buffer.concat(chunks), request.headers['content-type'] ?? '');
      if (!file) { response.writeHead(400); return response.end('no file'); }
      await mkdir(join(project, 'uploads'), {recursive: true});
      const stored = `${received.length + 1}-${basename(file.name)}`;
      await writeFile(join(project, 'uploads', stored), file.bytes);
      received.push({name: file.name, stored, type: file.type, bytes: file.bytes.length});
      response.writeHead(200, {'content-type': 'text/plain'}); return response.end(String(received.length));
    }
    if (url.pathname === '/uploads') { response.writeHead(200, {'content-type': 'application/json'}); return response.end(JSON.stringify(received)); }
    // The page is /filepond-example/ beside the plug-in it imports (../filepond.mjs, ../shrink.mjs).
    if (url.pathname === '/') { response.writeHead(302, {location: '/filepond-example/' + url.search}); return response.end(); }
    const file = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const path = file.startsWith('/node_modules/') ? join(project, file) : join(widgets, file);
    if (!path.startsWith(file.startsWith('/node_modules/') ? project : widgets)) throw new Error('outside');
    const body = await readFile(path);
    response.writeHead(200, {'content-type': TYPES[extname(path)] ?? 'application/octet-stream'}); response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/filepond-example/`));
