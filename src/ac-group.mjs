// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {ansGroupWriter} from './ans.mjs';
import {prefixGroupWriter} from './entropy.mjs';
import {acContexts, walkACGroup} from './vardct.mjs';

export function acGroupEncoder(model, maxOutputBytes = Infinity) {
  if (maxOutputBytes !== Infinity && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0))
    throw new RangeError('Invalid AC output reservation.');
  const coding = model.coding.kind === 'ans' ? ansGroupWriter(model.coding) : prefixGroupWriter(model.coding);
  const {contexts} = model;
  const state = {...model, contexts: {...contexts, ...acContexts(contexts.map, contexts.numDc, contexts.numCtxs)},
    nzeros: [0, 1, 2].map(() => new Int32Array(32 * 32)), groupsX: 1, map: [0, 1, 2], counted: true};
  return data => {
    const w = new BitWriter(Math.min(4096, maxOutputBytes), maxOutputBytes);
    try {
      walkACGroup({...state, ...data}, 0, (ctx, value) => coding.write(w, ctx, value));
      coding.flush?.(w);
      return {bytes: w.bytes, at: w.at, pending: w.pending, acc: w.acc};
    } finally { coding.reset?.(); }
  };
}

let current;
export function serveAcGroup(message) {
  const {id, g} = message;
  try {
    if (message.pool === 'ac-model') {
      current = null;
      if (!Number.isSafeInteger(message.maxOutputBytes) || message.maxOutputBytes <= 0)
        throw new RangeError('AC helpers require a bounded output reservation.');
      current = {id, encode: acGroupEncoder(message.model, message.maxOutputBytes)};
      return null;
    }
    if (message.pool !== 'ac-group') throw new Error('Unknown AC worker message.');
    if (!current || current.id !== id) throw new Error('AC group has no selected model.');
    const result = current.encode(message.data);
    return [{pool: 'ac-done', id, g, result}, [result.bytes.buffer]];
  } catch (error) {
    return [{pool: 'ac-done', id, g: g ?? -1, error: {name: String(error?.name ?? 'Error'),
      ...(typeof error?.code === 'string' ? {code: error.code} : {}), message: String(error?.message ?? error)}}, []];
  }
}

