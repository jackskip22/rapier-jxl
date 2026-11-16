// One page for Electron and Tauri. The package's browser files run here as they are: photos and JPEGs in their own
// workers, a video read by the page and encoded in the animation worker. Only Save is the host's.
import {encode} from './jpegxl/upload.browser.mjs';
import {recompress, restore} from './jpegxl/jpeg.browser.mjs';
import {encode as animate} from './jpegxl/animation.browser.mjs';

const $ = id => document.getElementById(id);
const buttons = ['photo', 'jpeg', 'video'].map($), [cancel, save, status, progress] = ['cancel', 'save', 'status', 'progress'].map($);
let busy = false, controller, result;

const bytes = r => { if (!r.bytes) throw Object.assign(new Error(r.reason.message), {code: r.reason.code}); return r.bytes; };
const sha256 = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
const show = (phase, fraction) => { status.value = phase; if (fraction !== undefined) progress.value = fraction; };
const report = phase => fraction => show(phase, fraction);

// Save: Electron's preload offers `rapierDesktop.save`; Tauri's `save` command opens the dialog and writes the file.
async function saveAs(data, name) {
  if (window.rapierDesktop) return window.rapierDesktop.save(data, name);
  return window.__TAURI__.core.invoke('save', data, {headers: {name: encodeURIComponent(name)}});
}

async function run(kind, file) {
  if (!file || busy) return;
  busy = true; result = undefined; controller = new AbortController();
  const {signal} = controller;
  buttons.forEach(b => { b.disabled = true; }); save.disabled = true; cancel.disabled = false; progress.value = 0;
  try {
    let out, note = '';
    if (kind === 'jpeg') {
      const original = new Uint8Array(await file.arrayBuffer());
      out = bytes(await recompress(original, {signal, onProgress: report('Recompressing…')}));
      const back = bytes(await restore(out, {signal, onProgress: report('Restoring…')}));
      if (await sha256(back) !== await sha256(original)) throw Object.assign(new Error('The restored JPEG differs from the original.'), {code: 'JXL_VERIFY'});
      note = `\nThe restored JPEG is the same file: ${await sha256(back)}`;
    } else if (kind === 'video') {
      out = bytes(await animate(file, {effort: 3, fidelity: {quality: 80}, signal, onProgress: report('Encoding video…')}));
    } else {
      out = bytes(await encode(file, {effort: 3, fidelity: {quality: 80}, signal, onProgress: report('Encoding…')}));
    }
    result = {data: out, name: `${file.name.replace(/\.[^.]*$/, '') || 'image'}.jxl`};
    progress.value = 1;
    show(`${out.byteLength.toLocaleString()} bytes from ${file.size.toLocaleString()}${note}`);
  } catch (error) {
    show(`${/^JXL_/.test(error?.code) ? error.code : error?.name === 'AbortError' ? 'JXL_CANCELED' : 'JXL_ERROR'}: ${error?.message || error}`);
  } finally { busy = false; buttons.forEach(b => { b.disabled = false; }); cancel.disabled = true; save.disabled = !result; }
}

for (const kind of ['photo', 'jpeg', 'video']) {
  const input = $(`${kind}-file`);
  $(kind).onclick = () => input.click();
  input.onchange = () => { const file = input.files[0]; input.value = ''; void run(kind, file); };
}
cancel.onclick = () => controller?.abort();
save.onclick = async () => {
  if (!result) return;
  try { const path = await saveAs(result.data, result.name); if (path) show(`Saved ${result.data.byteLength.toLocaleString()} bytes\n${path}`); }
  catch (error) { show(`JXL_SAVE: ${error?.message || error}`); }
};
// A dropped file: a video makes an animation, a JPEG a photo.
addEventListener('dragover', event => { event.preventDefault(); document.body.classList.add('over'); });
addEventListener('dragleave', () => document.body.classList.remove('over'));
addEventListener('drop', event => {
  event.preventDefault(); document.body.classList.remove('over');
  const file = event.dataTransfer?.files[0];
  void run(file?.type.startsWith('video/') ? 'video' : 'photo', file);
});
