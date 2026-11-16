// Electron's main process: the page is served from app://rapier/ so its workers and WebAssembly load as on a web server;
// the one native call is Save, through the platform's own dialog.
import {app, BrowserWindow, dialog, ipcMain, net, protocol, session} from 'electron';
import {realpath, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, join, normalize, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), 'web');
const headers = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'unsafe-inline'; connect-src 'self' blob:; img-src 'self' blob: data:; media-src blob:; base-uri 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin'
};
protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true}}]);

app.whenReady().then(() => {
  const mimes = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'};
  protocol.handle('app', async request => {
    let decoded;
    try { decoded = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response('', {status: 400, headers}); }
    const root = await realpath(web).catch(() => web);
    const candidate = normalize(join(root, decoded));
    const target = candidate.endsWith(sep) || candidate === root ? join(candidate, 'index.html') : candidate;
    const resolved = await realpath(target).catch(() => null);
    if (!resolved || resolved !== root && !resolved.startsWith(root + sep)) return new Response('', {status: resolved ? 403 : 404, headers});
    const file = await net.fetch(pathToFileURL(resolved).href);
    const mime = mimes[extname(resolved).toLowerCase()];
    return new Response(file.body, {status: file.status, headers: {...Object.fromEntries(file.headers), ...(mime ? {'Content-Type': mime} : {}), ...headers}});
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('save', async (_event, data, name) => {
    if (!(data instanceof Uint8Array)) throw new TypeError('Save expects image bytes.');
    const stem = basename(String(name || 'image')).replace(/[\0<>:"/\\|?*]+/g, '_').replace(/\.[^.]+$/, '') || 'image';
    const {canceled, filePath} = await dialog.showSaveDialog({defaultPath: `${stem}.jxl`, filters: [{name: 'JPEG XL', extensions: ['jxl']}]});
    if (canceled || !filePath) return null;
    await writeFile(filePath, data);
    return filePath;
  });
  const window = new BrowserWindow({width: 720, height: 560, webPreferences: {preload: join(web, '..', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  void window.loadURL('app://rapier/');
});
app.on('window-all-closed', () => app.quit());
