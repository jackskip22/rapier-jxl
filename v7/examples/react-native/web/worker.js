// Stills run here; an animation runs on the page (page.js), where the browser plays a video.
// The page sends the module addresses first: {type: 'init', upload, jpeg}.
let encode, recompress, restore;
const say = (value, transfer) => postMessage(value, transfer || []);
const refusal = (code, message) => Object.assign(new Error(message), {code});
const bytesOf = result => {
  if (!result.bytes) throw refusal(result.reason.code, result.reason.message);
  return result.bytes;
};
const running = new Map();
const ready = new Promise(resolve => { globalThis.__ready = resolve; });

async function run({op, id, mime, quality, effort, input}) {
  const controller = new AbortController(), {signal} = controller;
  running.set(id, controller);
  try {
    await ready;
    say({type: 'started', id});
    let bytes;
    if (op === 'restore') bytes = bytesOf(await restore(new Uint8Array(input), {signal}));
    else if (op === 'recompress') bytes = bytesOf(await recompress(new Uint8Array(input), {effort, signal}));
    else if (op === 'encode' || op === 'encodeExact')
      bytes = bytesOf(await encode(new Blob([input], {type: mime}), {effort, fidelity: op === 'encodeExact' ? 'exact' : {quality}, signal}));
    else throw refusal('JXL_MESSAGE', 'Unknown operation.');
    const copy = bytes.buffer.byteLength === bytes.length ? bytes : bytes.slice();
    say({type: 'done', id, bytes: copy.buffer ?? copy}, [copy.buffer ?? copy]);
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'JXL_CANCELED' : /^JXL_[A-Z0-9_]+$/.test(error?.code) ? error.code : 'JXL_MESSAGE';
    say({type: 'error', id, code, message: (error?.message || String(error)) + (error?.cause?.message ? ` (${error.cause.message})` : '')});
  } finally { running.delete(id); }
}
onmessage = async ({data}) => {
  if (data?.type === 'init') {
    try {
      ({encode} = await import(data.upload));
      ({recompress, restore} = await import(data.jpeg));
      globalThis.__ready();
      say({type: 'ready'});
    } catch (error) { say({type: 'error', id: null, code: 'JXL_WORKER', message: String(error?.message || error)}); }
  } else if (data?.type === 'cancel') running.get(data.id)?.abort();
  else if (typeof data?.id === 'string' && data.id) run(data);
  else say({type: 'error', id: null, code: 'JXL_MESSAGE', message: 'Expected an operation and its id.'});
};
