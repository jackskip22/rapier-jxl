// SPDX-License-Identifier: MIT
export type DecodeFormat = 'auto' | 'uint8' | 'uint16' | 'float32';
export type DecodedPixels = Uint8Array | Uint16Array | Float32Array;
export interface DecodeColorTarget {
  space: 'rgb' | 'gray' | 'xyb';
  whitePoint?: 'd65' | 'dci' | 'e' | 'd50' | [number, number];
  primaries?: 'srgb' | 'display-p3' | 'rec2020' | [[number, number], [number, number], [number, number]];
  transferFunction?: 'srgb' | 'linear' | 'bt709' | 'dci' | 'pq' | 'hlg' | 'gamma';
  /** Positive encoding exponent; infers transferFunction: 'gamma' when that field is omitted. Conflicting transfers are rejected. */
  gamma?: number;
  renderingIntent?: 0 | 1 | 2 | 3;
}
export interface DecodeLimits {
  maxPixels: number;
  maxSamples: number;
  /** Conservative budget for saved references, returned frames and the frame being rendered. */
  maxRetainedSamples: number;
  /** Bound samples plus evaluated Modular tree nodes within one frame. */
  maxModularWork: number;
  maxFrames: number;
  maxBoxes: number;
  maxMetadataBytes: number;
  maxInputBytes: number;
  maxFeatureBytes: number;
  maxFeatureWork: number;
}
export const DECODE_LIMITS: Readonly<DecodeLimits>;
export interface DecodeOptions extends Partial<DecodeLimits> {
  /** Auto selects 8/16-bit integers from the source depth, or float for floating/over-16-bit input. */
  format?: DecodeFormat;
  /** Original preserves the source color meaning. Select sRGB for a display image. */
  colorSpace?: 'original' | 'srgb' | 'linear-srgb' | 'display-p3' | 'rec2020' | 'xyb' | DecodeColorTarget;
  /** Apply all eight orientations to every output plane. Default true. */
  applyOrientation?: boolean;
  /** Unassociate RGBA RGB values when the first alpha channel is associated. Default false. Native planes are preserved. */
  unpremultiplyAlpha?: boolean;
  /** Apply signalled spot-color swatches to RGBA. Default false. Native extra channels are preserved. */
  renderSpotColors?: boolean;
  /** Also return the float32 color planes beside RGBA. Default false: planes is []. */
  planes?: boolean;
}
export interface DecodedBitDepth {bits: number; exponentBits: number; float: boolean}
export interface DecodedColorEncoding {
  space: string;
  spaceId?: number;
  wantICC?: boolean;
  whitePoint?: string | number[];
  primaries?: string | number[][];
  transferFunction?: string;
  gamma?: number;
  renderingIntent?: number;
  invertedCMYK?: boolean;
  iccSpace?: string | null;
  [key: string]: unknown;
}
export interface DecodedExtraChannel {
  /** JPEG XL extra-channel enum: alpha 0, depth 1, spot 2, selection 3, black 4, CFA 5, thermal 6, optional 15, nonoptional 16. */
  type: number;
  bitDepth: DecodedBitDepth;
  dimShift: number;
  name: string;
  associated: boolean;
  spotColor?: number[];
  cfaChannel?: number;
  width: number;
  height: number;
  /** Normalized full-resolution samples. Float inputs retain their floating range. */
  data: Float32Array;
}
export interface DecodedFrame {
  width: number;
  height: number;
  /** Interleaved RGBA. Integer outputs scale normalized channels to 255 or 65535 and clip; float output is not clipped. */
  data: DecodedPixels;
  format: Exclude<DecodeFormat, 'auto'>;
  /** With planes: true, normalized color planes in the selected output space, before RGBA conversion, unassociation or spot rendering; else []. */
  planes: Float32Array[];
  extraChannels: DecodedExtraChannel[];
  colorEncoding: DecodedColorEncoding;
  icc: Uint8Array | null;
  /** RGBA color meaning; native XYB and non-RGB/gray ICC spaces are converted to sRGB for the RGBA array. */
  rgbaColorEncoding: DecodedColorEncoding;
  rgbaICC: Uint8Array | null;
  /** Duration in the image's animation tick units. */
  duration: number;
  durationSeconds: number;
  timecode: number;
  name: string;
  alphaPremultiplied: boolean;
}
export interface DecodedBox {type: string; data: Uint8Array; compressed: boolean}
export interface DecodedAnimation {numerator: number; denominator: number; loops: number; timecodes: boolean}
export interface DecodedImage extends DecodedFrame {
  frames: DecodedFrame[];
  preview: DecodedFrame | null;
  /** Original EXIF-style orientation, 1 through 8. */
  orientation: number;
  orientationApplied: boolean;
  animation: DecodedAnimation | null;
  /** Metadata box payloads, decompressed when stored in brob. */
  boxes: DecodedBox[];
  /** Exif box payloads include their four-byte TIFF offset field. */
  exif: Uint8Array[];
  xmp: Uint8Array[];
  metadata: {
    width: number;
    height: number;
    bitDepth: DecodedBitDepth;
    colorEncoding: DecodedColorEncoding;
    icc?: Uint8Array;
    extraChannels: Omit<DecodedExtraChannel, 'data' | 'width' | 'height'>[];
    [key: string]: unknown;
  };
}
/** Decode a complete bare JPEG XL codestream or ISOBMFF container. Throws on malformed input or a configured resource limit. */
export function decode(bytes: Uint8Array, options?: DecodeOptions): DecodedImage;
export interface DecodeAsyncOptions extends DecodeOptions {
  /** Worker threads for one image; default the hardware threads, at most 8. Results equal decode()'s. */
  threads?: number;
}
/** decode() on worker threads: a single VarDCT frame is split into bands of rows. Other images decode on the calling thread. */
export function decodeAsync(bytes: Uint8Array, options?: DecodeAsyncOptions): Promise<DecodedImage>;
