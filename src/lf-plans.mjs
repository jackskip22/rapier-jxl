// SPDX-License-Identifier: MIT
export const lfPlanFor = effort => (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && effort >= 10 ? 'effort-10'
  : effort >= 9 ? 'effort-9' : effort >= 8 ? 'effort-8'
  : effort >= 7 ? 'effort-7' : effort >= 5 ? 'quick-or-fixed' : effort >= 3 ? 'plain-or-fixed' : null;
export const monotonicLfPlanFor = effort => (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && effort >= 10 ? 'monotonic-10'
  : effort >= 9 ? 'monotonic-9' : effort >= 8 ? 'monotonic-8' : 'effort-7';
