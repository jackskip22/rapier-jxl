import type {ContainerStreamOptions} from './codec/container-stream.mjs';
import type {Bytes, ImageInfo, InspectOptions, HeaderOptions, EditChanges} from './types.mjs';
export type {ContainerStreamOptions, ImageInfo, InspectOptions, HeaderOptions, EditChanges};
/** The image header, read synchronously from a file or its first bytes, with no pixel decoded: a container is read up
 * to the box the input cuts, under every container rule those bytes decide, and at most 64 KiB of a codestream split in
 * parts is joined. Up to 65,536 pixels a side, so a caller learns the size of a file decode would refuse. Refuses when
 * the header itself is not all there. */
export function header(input: Uint8Array, options?: HeaderOptions): ImageInfo;
/** header() of a copy, with details on request: 'metadata' (Exif, XMP and JUMBF, as edit writes them) and 'layout'
 * (the container's boxes, fragments and codestream). */
export function inspect(input: Uint8Array, options?: InspectOptions): Promise<ImageInfo>;
/** New bytes with the metadata and the container's framing changed as asked; the codestream and every other box stay
 * exact. */
export function edit(input: Uint8Array, changes: EditChanges): Promise<Bytes>;
/** A raw codestream wrapped in a container as it streams, chunk by chunk. */
export function stream(source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, options?: ContainerStreamOptions): AsyncGenerator<Bytes>;
