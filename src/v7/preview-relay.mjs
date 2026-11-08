// SPDX-License-Identifier: MIT
export function previewRelay(post, signal) {
  let serial = 0, waiting = null, closed = false;
  const ack = sequence => {
    if (waiting?.sequence !== sequence) return;
    const {resolve} = waiting; waiting = null; resolve();
  };
  const close = () => {
    closed = true;
    signal?.removeEventListener('abort', close);
    signal = post = null;
    const pending = waiting; waiting = null; pending?.resolve();
  };
  const send = value => {
    if (closed || waiting) return;
    return new Promise(resolve => {
      const sequence = ++serial;
      waiting = {sequence, resolve};
      try { post(value, sequence, [value.bytes.buffer]); }
      catch { ack(sequence); }
    });
  };
  if (signal?.aborted) close();
  else signal?.addEventListener('abort', close, {once: true});
  return {send, ack, close};
}

export function previewHub(port) {
  const open = new Map();
  return {
    ack(message) {
      if (message.previewAck === undefined) return false;
      open.get(message.id)?.ack(message.previewAck);
      return true;
    },
    start(id, signal) {
      const relay = previewRelay((value, sequence, transfer) => port.postMessage({id, preview: value, previewSequence: sequence}, transfer), signal);
      open.set(id, relay);
      return {send: relay.send, close() { relay.close(); open.delete(id); }};
    },
  };
}

export const previewReplies = {reply: replyPreview, clear: clearPreviewReply};

export function clearPreviewReply(job) {
  if (job.previewReply) job.previewReply.ack = null;
  job.previewReply = null;
}

export function replyPreview(job, value, sequence, observe, ack) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence <= (job.previewSequence ?? 0) || job.previewReply?.ack) return;
  job.previewSequence = sequence;
  const receipt = job.previewReply = {ack};
  const done = () => { const send = receipt.ack; receipt.ack = null; try { send?.(); } catch {} };
  let pending;
  try { pending = observe(value); } catch {}
  Promise.resolve(pending).then(done, done);
}
