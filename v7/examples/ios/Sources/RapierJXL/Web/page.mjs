// Relays Swift's calls to the worker and the worker's answers to Swift. Bytes never pass through here:
// the worker reads its input from /in/<id> and writes each output to /out/<id>/<kind>, both served by Swift.
const tell = message => webkit.messageHandlers.rapier.postMessage(JSON.stringify(message));
const worker = new Worker(new URL('./encoder.mjs', location.href), {type: 'module'});
const fail = message => tell({type: 'error', id: null, code: 'JXL_WORKER', message});
worker.onmessage = ({data}) => tell(data);
worker.onerror = event => { event.preventDefault(); fail(event.message || 'The encoder worker stopped.'); worker.terminate(); };
worker.onmessageerror = () => { fail('The encoder reply could not be read.'); worker.terminate(); };
globalThis.rapier = {run: job => worker.postMessage(job), cancel: id => worker.postMessage({type: 'cancel', id})};
