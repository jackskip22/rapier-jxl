// SPDX-License-Identifier: MIT
// Loaded first in a shim worker, before rapier-jxl's own worker file: a passive message listener that reports the
// shape of every job input and option record the queue posts, on a BroadcastChannel (never on the codec's own port).
import {shape, realm} from './shape.mjs';
const channel = new BroadcastChannel('rapier-jxl-probe');
channel.postMessage({kind: 'boot', realm: realm()});
self.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m !== 'object') return channel.postMessage({kind: 'other', type: typeof m});
  if (!('input' in m)) return channel.postMessage({kind: 'control', keys: Object.keys(m).slice(0, 8)});
  channel.postMessage({kind: 'job', id: m.id, operation: m.operation, keys: Object.keys(m), input: shape(m.input),
    options: m.options && typeof m.options === 'object' ? Object.keys(m.options) : typeof m.options});
});
