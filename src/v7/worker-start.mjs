// SPDX-License-Identifier: MIT

export const elsewhere = url => typeof location !== 'undefined' && !!url.origin && url.origin !== 'null' && url.origin !== location.origin;
export const program = href => 'const q=[],k=e=>q.push(e);addEventListener("message",k);import(' + JSON.stringify(href) +
  ').then(()=>{removeEventListener("message",k);for(const e of q)dispatchEvent(new MessageEvent("message",e))},e=>setTimeout(()=>{throw e}))';

export function startWorker(file) {
  const url = file.url?.();
  if (!url || !elsewhere(url)) return file.worker();
  const source = URL.createObjectURL(new Blob([program(url.href)], {type: 'text/javascript'})), done = () => URL.revokeObjectURL(source);
  let worker;
  try { worker = new Worker(source, {type: 'module'}); } catch (error) { done(); throw error; }
  const terminate = worker.terminate;
  worker.addEventListener('message', done, {once: true});
  worker.addEventListener('error', done, {once: true});
  worker.terminate = function () { done(); return terminate.call(this); };
  return worker;
}
