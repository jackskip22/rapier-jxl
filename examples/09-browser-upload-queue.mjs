// An upload queue in a page, Gutenberg's case: several photos go through one worker, one at a time and in order, each
// with its own progress, cancel and errors that carry a code. Pick files with the input, or call window.run() for a
// self-contained demonstration (the browser test does).
// With a bundler (Vite, webpack, Rollup, esbuild): import {createEncoder} from 'rapier-jxl';
import {createEncoder} from './node_modules/rapier-jxl/dist/index.mjs';

// One owned queue: one module worker, input copied at submission, bounded memory and job count.
const queue = createEncoder({maxPixels: 16_000_000, maxInputBytes: 64 * 1024 * 1024, maxQueuedJobs: 8});
const cancelAll = new AbortController();
const list = document.querySelector('#list');

function row(name) {
  const item = document.createElement('li'), progress = document.createElement('progress');
  item.textContent = name + ' ';
  item.append(progress);
  list.append(item);
  return {progress, done(text) { progress.remove(); item.append(text); }};
}

// One upload: encode, then hand the JPEG XL file to whatever stores it (here, a Blob for the page).
// A cancel rejects with the signal's AbortError; every other refusal carries a JXL_ code.
const codeOf = error => error?.name === 'AbortError' ? 'AbortError' : error?.code ?? error?.name;
function upload(file, {signal = cancelAll.signal, effort = 7, quality = 90} = {}) {
  const view = row(file.name), progress = [];
  const onProgress = fraction => { progress.push(fraction); view.progress.value = fraction; };
  // acceleration: 'wasm' runs the WebAssembly kernels where the page's CSP allows 'wasm-unsafe-eval', JavaScript otherwise.
  return queue.encode(file, {effort, quality, acceleration: 'wasm', signal, onProgress}).then(bytes => {
    view.done(`${bytes.length} bytes`);
    return {name: file.name, ok: true, bytes: bytes.length, progress, jxl: new Blob([bytes], {type: 'image/jxl'})};
  }, error => {
    view.done(`${codeOf(error)}: ${error.message}`);
    return {name: file.name, ok: false, code: codeOf(error), progress};
  });
}

document.querySelector('#files').addEventListener('change', event => { for (const file of event.target.files) upload(file); });
document.querySelector('#cancel').addEventListener('click', () => cancelAll.abort());

// A phone-like photo as a JPEG File, drawn in the page.
async function photo(name, width, height, seed) {
  const canvas = new OffscreenCanvas(width, height), g = canvas.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, `hsl(${200 + seed * 7} 60% 70%)`); sky.addColorStop(1, `hsl(${30 + seed * 11} 50% 45%)`);
  g.fillStyle = sky; g.fillRect(0, 0, width, height);
  for (let i = 0; i < 120; i++) {
    g.fillStyle = `hsl(${(seed * 41 + i * 17) % 360} 55% ${35 + (i % 30)}%)`;
    g.beginPath(); g.arc((i * 97 + seed * 31) % width, height / 2 + ((i * 53) % (height / 2)), 6 + (i % 25), 0, 7); g.fill();
  }
  return new File([await canvas.convertToBlob({type: 'image/jpeg', quality: 0.92})], name, {type: 'image/jpeg'});
}

// The demonstration: four photos in order, one canceled while it waits, one larger than the queue's pixel limit, a
// truncated file, and a request refused because the queue is full. Every result comes back; none is lost.
window.run = async () => {
  const started = performance.now(), order = [];
  const photos = await Promise.all([1, 2, 3, 4].map(n => photo(`photo-${n}.jpg`, 1600, 1200, n)));
  const cancelOne = new AbortController();
  const jobs = photos.map((file, i) => upload(file, i === 2 ? {signal: cancelOne.signal} : {}).then(result => (result.ok && order.push(file.name), result)));
  cancelOne.abort();
  const huge = await photo('panorama.jpg', 6000, 3000, 9);
  jobs.push(upload(huge));
  const broken = new File([new Uint8Array([255, 216, 255, 224, 0, 16])], 'truncated.jpg', {type: 'image/jpeg'});
  jobs.push(upload(broken));
  const results = await Promise.all(jobs);
  // A full queue refuses at once: fill the eight places, then ask for one more.
  const blocker = Array.from({length: 8}, () => queue.encode({data: new Uint8Array(4), width: 1, height: 1}, {lossless: true, effort: 1}).catch(error => error));
  const full = await queue.encode({data: new Uint8Array(4), width: 1, height: 1}).then(() => null, error => error.code);
  await Promise.all(blocker);
  return {results: results.map(({name, ok, bytes, code, progress}) => ({name, ok, bytes, code, progress})), order, queueFull: full,
    stats: queue.stats, ms: Math.round(performance.now() - started)};
};
