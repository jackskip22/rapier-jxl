// Electron's main process: the page is served from app://rapier/ so its workers and WebAssembly load as on a web server;
// the one native call is Save, through the platform's own dialog.
import {app, BrowserWindow, dialog, ipcMain, net, protocol, session} from 'electron';
import {writeFile} from 'node:fs/promises';
import {dirname, join, normalize, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), 'web');
const headers = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'unsafe-inline'; connect-src 'self' blob:; img-src 'self' blob: data:; media-src blob:; base-uri 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin'
};
protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true}}]);

app.whenReady().then(() => {
  protocol.handle('app', async request => {
    const path = normalize(join(web, decodeURIComponent(new URL(request.url).pathname)));
    if (path !== web && !path.startsWith(web + sep)) return new Response('', {status: 403});
    const file = await net.fetch(pathToFileURL(path.endsWith(sep) || path === web ? join(path, 'index.html') : path).href);
    return new Response(file.body, {status: file.status, headers: {...Object.fromEntries(file.headers), ...headers}});
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('save', async (_event, data, name) => {
    const {canceled, filePath} = await dialog.showSaveDialog({defaultPath: String(name), filters: [{name: 'JPEG XL', extensions: ['jxl']}]});
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
