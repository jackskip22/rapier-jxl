// SPDX-License-Identifier: MIT
import {kernelHooks} from './kernel-hooks.mjs';
import {packSigned} from './bits.mjs';
import {countToken, writeHybrid} from './prefix.mjs';
import {LZ77, RESIDUAL_CONFIG, GRADIENT_PREDICTOR} from './modular.mjs';

const {minSymbol: MIN_RUN_SYMBOL, minLength: MIN_RUN_LENGTH, lengthConfig: RUN_CONFIG} = LZ77;

function codeGradient(w, target, plane, width, height, config, raw) {
  const lengthConfig = RUN_CONFIG;
  let run = 0;
  const emit = (value, tokenConfig = config, base = 0) => {
    if (w) writeHybrid(w, target, tokenConfig, value, base);
    else if (raw && !base) target[value]++;
    else countToken(tokenConfig, value, target, raw ? target.length - 33 : base);
  };
  const flush = () => {
    if (!run) return;
    if (run >= MIN_RUN_LENGTH + 1) { emit(0); emit(run - MIN_RUN_LENGTH - 1, lengthConfig, MIN_RUN_SYMBOL); }
    else for (let i = 0; i < run; i++) emit(0);
    run = 0;
  };
  for (let y = 0, index = 0; y < height; y++) {
    for (let x = 0; x < width; x++, index++) {
      let pred = 0;
      if (x | y) {
        const left = x ? plane[index - 1] : plane[index - width];
        const top = y ? plane[index - width] : left;
        const nw = x && y ? plane[index - width - 1] : left, grad = left + top - nw;
        const lo = left < top ? left : top, hi = left < top ? top : left;
        pred = grad < lo ? lo : grad > hi ? hi : grad;
      }
      const r = (plane[index] - pred) | 0;
      if (!r) run++;
      else { flush(); emit(r >= 0 ? r + r : -r - r - 1); }
    }
  }
  flush();
}

export function codeChannel(w, target, plane, width, height, leaf, raw = false, visit, residuals, beginY = 0) {
  if (!visit && !residuals && kernelHooks.channel?.(w, target, plane, width, height, leaf, raw)) return;
  const predictor = leaf.predictor, offset = leaf.offset, multiplier = leaf.multiplier;
  if (!visit && !residuals && beginY === 0 && predictor === GRADIENT_PREDICTOR && multiplier === 1 && offset === 0)
    return codeGradient(w, target, plane, width, height, leaf.config || RESIDUAL_CONFIG, raw);
  const config = leaf.config || RESIDUAL_CONFIG, lengthConfig = RUN_CONFIG;
  let run = 0;
  const emit = (value, tokenConfig = config, base = 0) => {
    if (visit) visit(value, tokenConfig, base);
    else if (w) writeHybrid(w, target, tokenConfig, value, base);
    else if (raw && !base) target[value]++;
    else countToken(tokenConfig, value, target, raw ? target.length - 33 : base);
  };
  const flush = () => {
    if (!run) return;
    if (run >= MIN_RUN_LENGTH + 1) {
      emit(0);
      const count = run - MIN_RUN_LENGTH - 1;
      emit(count, lengthConfig, MIN_RUN_SYMBOL);
    } else for (let i = 0; i < run; i++) emit(0);
    run = 0;
  };
  const residual = (index, pred) => {
    const value = plane[index];
    let r;
    if (multiplier === 1) r = (value - pred - offset) | 0;
    else { r = Math.round((value - pred - offset) / multiplier); plane[index] = pred + offset + r * multiplier; }
    if (residuals) { residuals[index] = r; return; }
    if (r === 0) { run++; return; }
    flush();
    emit(packSigned(r));
  };
  for (let y = beginY, index = beginY * width; y < height; y++) {
    for (let x = 0; x < width; x++, index++) {
      let pred;
      if (predictor === 0) pred = 0;
      else {
        const left = x ? plane[index - 1] : y ? plane[index - width] : 0;
        const top = y ? plane[index - width] : left;
        if (predictor === 1) pred = left;
        else if (predictor === 2) pred = top;
        else if (predictor === 3) pred = ((left + top) / 2) | 0;
        else {
          const topleft = x && y ? plane[index - width - 1] : left, grad = left + top - topleft;
          if (predictor === 5) {
            const lo = left < top ? left : top, hi = left < top ? top : left;
            pred = grad < lo ? lo : grad > hi ? hi : grad;
          } else if (predictor === 4) pred = Math.abs(grad - left) < Math.abs(grad - top) ? left : top;
          else throw new Error('predictor ' + predictor + ' is not coded here');
        }
      }
      residual(index, pred);
    }
  }
  flush();
}
