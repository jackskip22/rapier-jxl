export const frameMilliseconds = (frame, animation) => frame.duration * 1000 * animation.denominator / animation.numerator;
const defaultSleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, {once: true});
});
export async function play({decode, bytes, animation, signal, show, toURL, release, window = 3, options = {}, now = () => performance.now(), sleep = defaultSleep}) {
  let current = null;
  try {
    for (let loop = 0; !signal.aborted && (animation.loops === 0 || loop < animation.loops); loop++) {
      const queue = []; let finished = false, failure, producerWake = null, consumerWake = null;
      const poke = () => { const wake = consumerWake; consumerWake = null; wake?.(); };
      const pending = signal => new Promise(resolve => { producerWake = resolve; signal.addEventListener('abort', resolve, {once: true}); });
      const producer = Promise.resolve(decode(bytes, {...options, signal, onFrame: async frame => {
        const url = await toURL(frame);
        if (signal.aborted) { release(url); return; }
        queue.push({url, ms: frameMilliseconds(frame, animation)}); poke();
        while (queue.length >= window && !signal.aborted) await pending(signal);
      }})).then(() => {}, error => { failure = error; }).finally(() => { finished = true; poke(); });
      let at = now();
      for (;;) {
        while (!queue.length && !finished && !signal.aborted) await new Promise(resolve => { consumerWake = resolve; signal.addEventListener('abort', resolve, {once: true}); });
        if (signal.aborted || !queue.length) break;
        const frame = queue.shift(); { const wake = producerWake; producerWake = null; wake?.(); }
        if (at > now()) await sleep(at - now(), signal);
        if (signal.aborted) { release(frame.url); break; }
        await show(frame.url);
        if (current !== null) release(current);
        current = frame.url; at += frame.ms;
      }
      for (const frame of queue.splice(0)) release(frame.url);
      await producer;
      if (failure && !signal.aborted) throw failure;
      if (!signal.aborted && (animation.loops === 0 || loop + 1 < animation.loops) && at > now()) await sleep(at - now(), signal);
    }
  } finally { if (current !== null) release(current); }
}
