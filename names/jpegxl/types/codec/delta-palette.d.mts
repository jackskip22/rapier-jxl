// SPDX-License-Identifier: MIT
import type {Bytes, Job} from './index.mjs';

export interface DeltaPaletteOptions {
  /** Source primaries, without converting sample values. Defaults to srgb. */
  colorSpace?: 'srgb' | 'display-p3' | undefined;
  /** Auto compares the existing core and screen encodings with implicit delta palettes.
   * Explicit and hybrid also use custom difference tables, decoded by libjxl 0.12.0 and Chrome 155;
   * jxl-oxide 0.12.6 does not decode explicit difference tables correctly. Defaults to auto. */
  paletteMode?: 'auto' | 'implicit' | 'explicit' | 'hybrid' | undefined;
  /** Predictor of reconstructed color and alpha samples; auto tries all five. */
  deltaPredictor?: 'auto' | 'left' | 'top' | 'average' | 'gradient' | 'weighted' | undefined;
  /** Maximum custom difference entries per group, 1–4096. Explicit/hybrid only; default 256. */
  maxDeltaEntries?: number | undefined;
  /** Maximum explicit absolute-color entries per group, 1–65536; default 4096. */
  maxPaletteColors?: number | undefined;
  /** Maximum group edge; default 1024. Smaller groups bound scratch and allow local palettes. */
  groupSize?: 128 | 256 | 512 | 1024 | undefined;
  /** Existing screen search to include in auto: 1–2 use the core floor, 3–9 search screens; default 5. */
  screenEffort?: number | undefined;
}

/** Exact RGBA8 encoding, including unassociated alpha and RGB under zero alpha.
 * Throws JXL_SIZE if a forced palette cannot represent a group within the chosen entry limits.
 * Auto retains a completed ordinary encoding when a palette cannot fit or is larger. */
export function encodeDeltaPalette(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options?: DeltaPaletteOptions): Bytes;
/** Breaking iteration cancels. Hurry returns a complete auto candidate or finishes forced palette groups
 * with reduced search. Keep input samples unchanged until the iterator completes. */
export function encodeDeltaPaletteSteps(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options?: DeltaPaletteOptions): Job;
