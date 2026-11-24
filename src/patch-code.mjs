// SPDX-License-Identifier: MIT
import {BitWriter, packSigned, scaled} from './bits.mjs';
import {fault} from './admit.mjs';
import {buildCode, uintConfig, countToken, writeHistograms, writeHybrid} from './prefix.mjs';
import {screenPlan, screenFrameSteps} from './screen.mjs';
import {writePatchFrameHeader} from './screen-patches.mjs';

function* patchTokens(plan, emit) {
  let done = 0, previousYield = 0;
  const write = (ctx, value) => { emit(ctx, value); done++; };
  write(0, plan.groups.length);
  for (const group of plan.groups) {
    write(1, group.reference); write(3, group.sx); write(3, group.sy); write(2, group.w - 1); write(2, group.h - 1); write(7, group.positions.length - 1);
    let x = 0, y = 0;
    for (let i = 0; i < group.positions.length; i++) {
      const p = group.positions[i];
      write(i ? 6 : 4, i ? packSigned(p.x - x) : p.x); write(i ? 6 : 4, i ? packSigned(p.y - y) : p.y); x = p.x; y = p.y;
      for (const blend of p.blending) {
        write(5, blend.mode);
        if (blend.mode >= 4 && plan.extraChannels > 1) write(8, blend.alpha);
        if (blend.mode >= 3) write(9, Number(blend.clamp));
      }
      if (done - previousYield >= 4096) { previousYield = done; yield done / plan.tokens; }
    }
  }
  yield 1;
}
export function* authoredPatchEntropy(plan) {
  const config = uintConfig(4), freqs = Array.from({length: 10}, () => new Uint32Array(64)), one = new Uint32Array(64);
  for (const progress of patchTokens(plan, (ctx, value) => { countToken(config, value, freqs[ctx]); countToken(config, value, one); })) yield progress / 3;
  let best = null;
  for (const [contextMap, histograms] of [[Uint8Array.from({length: 10}, (_, i) => i), freqs.map(freq => ({config, code: buildCode(freq)}))],
    [new Uint8Array(10), [{config, code: buildCode(one)}]]]) {
    const writer = new BitWriter(256), shared = histograms.length === 1;
    writeHistograms(writer, {contextMap, histograms});
    for (const progress of patchTokens(plan, (ctx, value) => writeHybrid(writer, histograms[shared ? 0 : ctx].code, config, value))) yield (shared ? 2 : 1) / 3 + progress / 3;
    if (!best || writer.bitLength < best.bitLength) best = writer;
  }
  return best;
}

export function* authoredPatchFrame(data, width, height, options, {reference = false, dictionary = null} = {}) {
  const {shape, colorSpace, effort} = options, plans = new Map();
  const candidates = [['global', 0, 7], ['direct', -1, 7]];
  if (effort >= 2) candidates.push(['global', 1, 7], ['direct', 1, 7]);
  if (effort >= 3) candidates.push(['frequency', 1, 7], ['scalar', 1, 7]);
  if (effort >= 5) for (const name of ['global', 'frequency', 'scalar', 'direct']) candidates.push([name, 4, 7]);
  if (effort >= 7) for (const name of ['global', 'frequency', 'scalar', 'direct']) candidates.push([name, 4, 4]);
  if (effort >= 8) for (const name of ['global', 'frequency']) candidates.push([name, 16, 4]);
  if (effort >= 9) for (const name of ['global', 'frequency', 'direct']) candidates.push([name, 64, 4]);
  let best, failure, hurry = false;
  for (let i = 0; i < candidates.length; i++) {
    const [name, strategy, minLength] = candidates[i];
    if (best && (hurry || strategy < 0)) continue;
    if (!plans.has(name)) plans.set(name, screenPlan(data, width, height, shape, name));
    const plan = plans.get(name);
    if (!plan) continue;
    const search = strategy > 1 ? {dim: 1024, depth: strategy} : null;
    const steps = screenFrameSteps(data, width, height, shape, colorSpace, plan, {
      imageHeader: false, tokenCodec: strategy === 1 ? 1 : null, search, minLength,
      frameHeader: writer => writePatchFrameHeader(writer, shape.alpha, {reference, width, height, shift: search ? 3 : 1}),
      globalPrefix: dictionary ? writer => writer.append(dictionary) : null
    });
    try {
      let step, reply = false;
      try { while (!(step = steps.next(reply)).done) {
        const requested = yield scaled(step.value, fraction => (i + fraction) / candidates.length);
        hurry ||= !!requested;
        reply = !!best && hurry;
      } } finally { if (!step?.done) steps.return?.(); }
      if (step.value && (!best || step.value.length < best.length)) best = step.value;
    } catch (error) {
      if (error.code !== 'JXL_SIZE') throw error;
      failure = error;
    }
  }
  if (!best) throw failure || fault('JXL_SIZE', 'patches: over maxBytes');
  yield 1;
  return best;
}
