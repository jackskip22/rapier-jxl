// SPDX-License-Identifier: MIT
export const DECODER_KEY = Symbol.for('rapier-jxl.decoder');
export const configuredDecoder = () => globalThis[DECODER_KEY] ?? null;
