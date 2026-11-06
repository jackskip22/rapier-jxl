// SPDX-License-Identifier: MIT
export const lfPlanFor = effort => effort >= 9 ? 'effort-9' : effort >= 8 ? 'effort-8'
  : effort >= 7 ? 'effort-7' : effort >= 5 ? 'quick-or-fixed' : effort >= 3 ? 'plain-or-fixed' : null;
export const monotonicLfPlanFor = effort => effort >= 9 ? 'monotonic-9' : effort >= 8 ? 'monotonic-8' : 'effort-7';
export const lfPlanPlainMetadata = name => name == null || name === 'fixed' || name === 'plain-or-fixed';
