import {encode} from './jpegxl/upload.mjs';
import {recompress, restore} from './jpegxl/jpeg.mjs';

const say = value => postMessage(value);
const refusal = (code, message) => Object.assign(new Error(message), {code});
const bytesOf = result => {
  if (!result.bytes) throw refusal(result.reason.code, result.reason.message);
  return result.bytes;
};
const put = (id, kind, bytes) => fetch(`/out/${id}/${kind}`, {method: 'POST', body: bytes}).then(response => {
  if (!response.ok) throw refusal('JXL_BRIDGE', 'Swift did not take the result.');
});
const running = new Map();

async function run({op, id, mime, quality, effort}) {
  const controller = new AbortController(), {signal} = controller;
  running.set(id, controller);
  try {
    const response = await fetch(`/in/${id}`);
    if (!response.ok) throw refusal('JXL_BRIDGE', 'Swift did not send the input.');
    const input = await response.arrayBuffer();
    say({type: 'started', id});
    if (op === 'restore') await put(id, 'result', bytesOf(await restore(new Uint8Array(input), {signal})));
    else if (op === 'recompress') await put(id, 'result', bytesOf(await recompress(new Uint8Array(input), {effort, signal})));
    else if (op === 'animate') {
      const {encode: animate} = await import('./jpegxl/animation.mjs');
      await put(id, 'result', bytesOf(await animate(new Blob([input], {type: 'image/gif'}), {effort, fidelity: {quality}, signal})));
    } else if (op === 'encode' || op === 'encodeExact')
      await put(id, 'result', bytesOf(await encode(new Blob([input], {type: mime}),
        {effort, fidelity: op === 'encodeExact' ? 'exact' : {quality}, signal})));
    else throw refusal('JXL_MESSAGE', 'Unknown operation.');
    say({type: 'done', id});
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'JXL_CANCELED' : /^JXL_[A-Z0-9_]+$/.test(error?.code) ? error.code : 'JXL_MESSAGE';
    say({type: 'error', id, code, message: (error?.message || String(error)) + (error?.cause?.message ? ` (${error.cause.message})` : '')});
  } finally { running.delete(id); }
}
onmessage = ({data}) => {
  if (data?.type === 'cancel') running.get(data.id)?.abort();
  else if (typeof data?.id === 'string' && data.id) run(data);
  else say({type: 'error', id: null, code: 'JXL_MESSAGE', message: 'Expected an operation and its id.'});
};
say({type: 'ready'});
