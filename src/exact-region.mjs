// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {xybStrategies} from './varblocks.mjs';

export {subImage, bandedRGBA, exactScores} from './photo-reconstruct-bands.mjs';

export function exactAnswerer(width, height, wholeMeasure, signal = null) {
  if (typeof wholeMeasure !== 'function') throw fault('JXL_INTERNAL', 'exact-region:measure');
  let destroyed = false, busy = false;
  const answer = async request => {
    if (signal?.aborted) throw signal.reason;
    if (destroyed) throw Object.assign(new Error('closed'), {name: 'AbortError'});
    if (busy) throw fault('JXL_MEMORY', 'concurrent exact request');
    busy = true;
    try {
      const {p = 3, margin = 2} = request;
      if (!Number.isSafeInteger(margin) || margin < 0) throw fault('JXL_INTERNAL', 'exact-region:margin');
      const measured = image => { const {cells, blocks} = wholeMeasure(image, {p, margin, ssimulacra2: false}); return {whole: true, cells, blocks}; };
      if (request.kind === 'whole') return measured(request.image);
      if (request.kind !== 'cells' && request.kind !== 'blocks') return null;
      if (!request.regions.length) return request.kind === 'cells' ? new Map() : {cells: new Map(), blocks: new Map()};
      if (request.kind === 'blocks') return measured(request.image);
      const out = new Map();
      for (const id of request.ids) out.set(id, measured(xybStrategies(request.base, width, height, {...request.options, force: id, maps: null}).image));
      return out;
    } finally { busy = false; }
  };
  answer.fallbacks = 0;
  answer.destroy = () => { destroyed = true; wholeMeasure = null; return Promise.resolve(); };
  return answer;
}
