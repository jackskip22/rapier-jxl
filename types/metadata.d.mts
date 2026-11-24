import type {ContainerStreamOptions} from './codec/container-stream.mjs';
import type {Bytes, EncodedInput, ImageHeader, ImageInfo, InspectOptions, HeaderOptions, EditChanges} from './types.mjs';
export type {ContainerStreamOptions, EncodedInput, ImageHeader, ImageInfo, InspectOptions, HeaderOptions, EditChanges};
/** The image header, read synchronously from a file or its first bytes, with no pixel decoded: a container is read up
 * to the box the input cuts, under every container rule those bytes decide, and at most 64 KiB of a codestream split in
 * parts is joined. Up to the format's 2^30 pixels a side. Refuses when
 * the header itself is not all there. A JPEG XL file only: inspect reads a JPEG's or PNG's header. Caller bytes
 * use an ArrayBuffer or any view of one. SharedArrayBuffer backing is refused at runtime with JXL_INPUT.
 * Unknown header options refuse JXL_OPTIONS.
 * @example const {width, height} = header(jxl); */
export function header(input: EncodedInput, options?: HeaderOptions): Omit<ImageHeader, 'icc'>;
/** The image header after complete JPEG XL container framing is admitted, with details on request: 'metadata'
 * (Exif, XMP and JUMBF) and 'layout' (boxes, fragments and codestream). This does not validate compressed pixel data.
 * Also reads a JPEG's or PNG's intrinsic size, orientation, sample depth and color statement up to its first scan.
 * An embedded profile is read and grayscale stays grayscale. These source formats take no details.
 * Invalid details or decompress options refuse JXL_OPTIONS. A file above maxInputBytes refuses JXL_LIMIT.
 * @example const {width, height, orientation} = await inspect(jpeg); */
export function inspect(input: EncodedInput, options?: InspectOptions): Promise<ImageInfo>;
/** New bytes with the metadata and the container's framing changed as asked. The codestream and every other box stay
 * exact.
 * A file above maxInputBytes refuses JXL_LIMIT. An invalid JPEG XL signature refuses JXL_INPUT. null changes nothing.
 * @example const tagged = await edit(jxl, {xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'}); */
export function edit(input: EncodedInput, changes: EditChanges | null): Promise<Bytes>;
/** The Exif and XMP a JPEG, PNG or WebP file carries, ready for `edit`, with the Exif orientation set to normal for pictures
 * whose pixels were already turned upright. Nothing is decoded. A file of another format refuses JXL_INPUT. A file with
 * neither is null, which `edit` takes as no change.
 * @example const tagged = await edit(jxl, await sourceMetadata(file)); // null: the file as it is */
export function sourceMetadata(input: Uint8Array | Blob): Promise<{exif: Uint8Array; xmp?: string} | {exif?: Uint8Array; xmp: string} | null>;
/** A raw codestream wrapped in a container as it streams, chunk by chunk.
 * Unsupported stream options refuse JXL_OPTIONS. Chunks are encoded byte buffers or views, awaited if promised. Invalid iterators or chunks refuse JXL_INPUT.
 * @example for await (const part of stream(codestream)) parts.push(part); */
export function stream(source: Iterable<EncodedInput | PromiseLike<EncodedInput>> | AsyncIterable<EncodedInput | PromiseLike<EncodedInput>>, options?: ContainerStreamOptions): AsyncGenerator<Bytes>;

export interface PlaceholderOptions {
  /** 'jxl' (default): the file's bytes. 'dataUrl' adds a data:image/jxl URL of them. */
  format?: "jxl" | "dataUrl"; }
export interface PlaceholderResult { bytes: Bytes; width: number; height: number; previewWidth: number; previewHeight: number; scale: 8; dataUrl?: string; }
export interface SliceOptions {
  /** The size wanted: 1, 2, 4 or 8 (1:8 is every VarDCT file's, 1:4 and 1:2 a progressive file's). A missing one refuses JXL_UNSUPPORTED. */
  scale?: 1 | 2 | 4 | 8;
  /** The smallest size at least this many pixels wide. */
  maxWidth?: number;
  /** The largest size in at most this many bytes. None refuses JXL_LIMIT. */
  maxBytes?: number; }
/** width and height are the picture's, and renderedWidth and renderedHeight are the detail the file carries. */
export interface SliceResult { bytes: Bytes; scale: 1 | 2 | 4 | 8; width: number; height: number; renderedWidth: number; renderedHeight: number; }
/** A complete JPEG XL file of a VarDCT still's 1:8 image, cut from the file or from its first bytes once they hold the
 * LF groups, without decoding. A prefix before them refuses JXL_INPUT. A Modular, animated or framed file, or one with alpha,
 * JXL_UNSUPPORTED.
 * @example const {dataUrl} = placeholder(jxl, {format: 'dataUrl'}); */
export function placeholder(input: EncodedInput, options?: PlaceholderOptions): PlaceholderResult;
/** A complete JPEG XL file of one of a VarDCT still's sizes, cut from the whole file without decoding: encode with
 * progressive: true for 1:4 and 1:2. Refuses what placeholder() refuses.
 * @example const {bytes} = slice(jxl, {maxWidth: 480}); */
export function slice(input: EncodedInput, options?: SliceOptions): SliceResult;
/** Codes for refusals raised by rapier-jxl. Caller callback errors and abort reasons pass through unchanged. */
export type {CodecError, ErrorCode} from './types.mjs';
