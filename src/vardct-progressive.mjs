// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {fault} from './admit.mjs';

export function progressivePasses(option) {
  if (option === undefined || option === false) return null;
  let passes;
  if (option === true || option === 'spectral') passes = [{downsample: 4, shift: 0}, {downsample: 2, shift: 0}, {downsample: 1, shift: 0}];
  else if (option === 'successive') passes = [{downsample: 1, shift: 2}, {downsample: 1, shift: 1}, {downsample: 1, shift: 0}];
  else if (option === 'responsive') passes = [{downsample: 4, shift: 1}, {downsample: 2, shift: 1}, {downsample: 1, shift: 1}, {downsample: 1, shift: 0}];
  else if (option && typeof option === 'object' && Array.isArray(option.passes)) passes = option.passes;
  else throw fault('JXL_INPUT', 'progressive is false, spectral, successive, responsive, or an object with 2–11 passes.');
  if (passes.length < 2 || passes.length > 11) throw fault('JXL_INPUT', 'A progressive frame has two through eleven passes.');
  passes = passes.map(pass => {
    if (!pass || typeof pass !== 'object') throw fault('JXL_INPUT', 'Each progressive pass gives downsample and shift.');
    const downsample = pass.downsample ?? 1, shift = pass.shift ?? 0;
    if (![1, 2, 4, 8].includes(downsample) || !Number.isInteger(shift) || shift < 0 || shift > 3)
      throw fault('JXL_INPUT', 'Progressive downsample is 1, 2, 4 or 8; shift is an integer from zero through three.');
    return {downsample, shift, scale: 1 << shift};
  });
  for (let i = 1; i < passes.length; i++) if (passes[i].downsample > passes[i - 1].downsample || passes[i].shift > passes[i - 1].shift)
    throw fault('JXL_INPUT', 'Progressive passes refine resolution and coefficient precision in order.');
  if (passes.at(-1).downsample !== 1 || passes.at(-1).shift !== 0) throw fault('JXL_INPUT', 'The last progressive pass must finish full resolution at shift zero.');
  const header = new BitWriter(32), hints = [];
  header.writeU32([[0, 1], [0, 2], [0, 3], [3, 4]], passes.length);
  for (let i = 0; i < passes.length - 1 && i < 8; i++) {
    const {downsample, shift} = passes[i];
    if (shift === 0 && downsample < (hints.at(-1)?.downsample ?? 8)) hints.push({downsample, last: i});
  }
  header.writeU32([[0, 0], [0, 1], [0, 2], [1, 3]], hints.length);
  for (const pass of passes.slice(0, -1)) header.write(2, pass.shift);
  for (const hint of hints) header.writeU32([[0, 1], [0, 2], [0, 4], [0, 8]], hint.downsample);
  for (const hint of hints) header.writeU32([[0, 0], [0, 1], [0, 2], [3, 0]], hint.last);
  const value = (coefficient, position, width, height, passIndex) => {
    if (!coefficient) return 0;
    const x = position % width, y = Math.floor(position / width);
    let reconstructed = 0;
    for (let i = 0; i <= passIndex; i++) {
      const pass = passes[i];
      const part = x < width / pass.downsample && y < height / pass.downsample ?
        Math.trunc((coefficient - reconstructed) / pass.scale) : 0;
      if (i === passIndex) return part;
      reconstructed += part * pass.scale;
    }
    return 0;
  };
  return {passes, count: passes.length, header, value, alphaPass: hints.find(hint => hint.downsample === 1)?.last ?? passes.length - 1};
}
