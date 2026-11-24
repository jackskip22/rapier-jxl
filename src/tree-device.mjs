// SPDX-License-Identifier: MIT
const AUDIT_EVERY = 16, MIN_MEMBERS = 64;
const answered = (a, cells) => a === null || (a instanceof Uint32Array ? a.length === cells : typeof a === 'object' && Number.isInteger(a.column));
const askable = (st, node) => node.ids.length >= MIN_MEMBERS && node.depth < st.options.depth && node.ownBits !== 0;
export function* deviceNodes(st, items) {
  if (!items) {
    st.spec = null;
    if (!st.deviceAsked) return true;
    const heard = yield {gpu: {kind: 'ma-nodes', samples: st.samples, ...(st.auditFailed && !st.told ? {failed: true} : {end: true})}};
    return !st.recorded || !st.auditFailed && heard?.refused !== true;
  }
  if (st.auditFailed) { st.device = null; st.spec = null; st.told = true; yield {gpu: {kind: 'ma-nodes', samples: st.samples, failed: true}}; return; }
  const spec = st.spec ??= new WeakMap();
  let level = items.filter(item => askable(st, item) && !spec.has(item.ids)).map(({ids, hist, ownBits, depth}) => ({ids, hist, ownBits, depth}));
  while (level.length) {
    st.deviceAsked = true;
    const answer = yield {gpu: {kind: 'ma-nodes', samples: st.samples, nodes: level.map(node => node.ids)}};
    if (!(Array.isArray(answer) && answer.length === level.length && answer.every(a => answered(a, st.samples.cells)))) { st.device = null; st.spec = null; return; }
    const next = [];
    for (let i = 0; i < level.length; i++) {
      const node = level[i], record = answer[i], known = {record, taken: null};
      spec.set(node.ids, known);
      if (record === null || record instanceof Uint32Array) continue;
      try { known.taken = st.store.split(node.ids, node.hist, node.ownBits, record); }
      catch (error) { if (error?.message !== 'kernel-hooks:sampled') throw error; st.device = null; st.spec = null; return; }
      if (node.ownBits - record.loBits - record.hiBits <= 0) continue;
      const best = known.taken;
      for (const child of [{ids: best.highIds, hist: best.high, ownBits: record.hiBits, depth: node.depth + 1},
        {ids: best.lowIds, hist: best.low, ownBits: record.loBits, depth: node.depth + 1}]) if (askable(st, child)) next.push(child);
    }
    level = next;
  }
  for (const item of items) {
    const known = spec.get(item.ids);
    if (!known) continue;
    spec.delete(item.ids);
    item.device = known.record; item.taken = known.taken;
    if (known.record !== null && !(known.record instanceof Uint32Array)) { st.recorded = true; if ((st.answered = (st.answered ?? 0) + 1) % AUDIT_EVERY === 1) item.audit = true; }
  }
}
