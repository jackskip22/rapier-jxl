// SPDX-License-Identifier: MIT
export const verificationRows = (width, quantum = 1) => Math.max(quantum, Math.min(64, Math.floor(16384 / width / quantum) * quantum));
