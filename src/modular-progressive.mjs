// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {progressivePasses} from './vardct-progressive.mjs';

export function modularPasses(option) {
  if (option === undefined || option === false) return null;
  const passes = option === true || option === 'resolution' ? [4, 2, 1] : option?.passes;
  if (!Array.isArray(passes) || passes.length < 2 || passes.length > 4 ||
      Array.from(passes).some((value, index) => ![1, 2, 4, 8].includes(value) || index && value >= passes[index - 1]) || passes.at(-1) !== 1)
    throw fault('JXL_INPUT', 'Modular progressive is false, true, resolution, or {passes: [4, 2, 1]}; two through four strictly decreasing scales from 8, 4, 2, 1 must end at one.');
  if (typeof option === 'object' && (Array.isArray(option) || Object.keys(option).some(key => key !== 'passes')))
    throw fault('JXL_INPUT', 'A Modular progression object contains only passes.');
  const plan = progressivePasses({passes: passes.map(downsample => ({downsample, shift: 0}))});
  return {count: plan.count, header: plan.header, brackets: plan.brackets};
}
