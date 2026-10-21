// SPDX-License-Identifier: MIT
import type {Bytes} from './index.mjs';
export interface DeliveryReadOptions {
  maxBytes?: number;
  iccBitLength?: number;
}
export interface DeliveryRegion {x: number; y: number; width: number; height: number}
export interface DeliveryOptions extends DeliveryReadOptions {
  /** Rectangle in canvas pixels before applying Exif orientation; a selected preview uses its own canvas.
   * LF dependency frames accept explicit sectionOrder only. */
  region?: DeliveryRegion;
  /** Region-first completes all passes of intersecting groups first. Pass-first refines the whole image in stages. */
  strategy?: 'region-first' | 'pass-first';
  /** Default: last image frame. -1 selects a dedicated preview. */
  frameIndex?: number;
  /** Every logical section index, exactly once, in requested physical order. Mutually exclusive with region. */
  sectionOrder?: readonly number[];
}
export interface DeliverySection {
  index: number;
  physicalIndex: number;
  /** Absolute byte offset in the naked codestream, excluding all container headers. */
  byteOffset: number;
  byteLength: number;
  kind: 'combined' | 'lf-global' | 'dc-group' | 'hf-global' | 'ac-group';
  group?: number;
  pass?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
export interface DeliveryFrame {
  index: number;
  type: number;
  dcLevel: number;
  modular: boolean;
  width: number;
  height: number;
  byteOffset: number;
  byteLength: number;
  sectionsByteOffset: number;
  groups: number;
  dcGroups: number;
  passes: number;
  sectionOrder: number[];
  sections: DeliverySection[];
}
export interface DeliveryLayout {
  width: number;
  height: number;
  level: 5 | 10;
  imageHeaderBytes: number;
  codestreamBytes: number;
  preview: DeliveryFrame | null;
  frames: DeliveryFrame[];
}
/** Inspect supported encoder headers and this entry's one-histogram, no-LZ77, prefix-coded permutation form.
 * Other entropy forms, including ANS permutations, are explicitly refused. */
export function deliveryLayout(bytes: Uint8Array, options?: DeliveryReadOptions): DeliveryLayout;
/** Change only TOC serialization and physical section order; decoded samples remain exact. The no-option
 * call retains all input bytes. Real TOC changes refuse jbrd reconstruction files. */
export function withDeliveryOrder(bytes: Uint8Array, options?: DeliveryOptions): Bytes;
/** Recover ordinary logical section order for layers, animation or progressive container helpers. */
export function normalizeDelivery(bytes: Uint8Array, options?: DeliveryReadOptions): Bytes;
