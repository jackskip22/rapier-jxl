// SPDX-License-Identifier: MIT
import type {Buffer} from 'node:buffer';
import type {Config, Payload, PayloadRequest, SanitizedCollectionConfig} from 'payload';

export interface JxlCollectionOptions {
  /** Encoding effort from 1 (fastest) to 9 (smallest). */
  effort?: number;
  /** Encoder fidelity for non-JPEG formats. When omitted, uses the encoder's default. */
  fidelity?: 'exact' | {quality: number};
  /**
   * Retire the main JPEG in Payload's job queue after the upload commits and its JPEG XL companion verifies.
   * Non-JXL requests rebuild the original JPEG on demand, and restoreOriginals puts retired originals back.
   */
  spaceSaver?: boolean;
}

export interface JxlPayloadOptions extends JxlCollectionOptions {
  /** Restrict or configure specific upload collection slugs. Defaults to all image upload collections. */
  collections?: string[] | Record<string, boolean | JxlCollectionOptions>;
  /** Optional sharp instance for decoding non-PNG/non-JPEG formats when Payload config does not supply sharp. */
  sharp?: unknown;
}

export interface JxlRenditionMetadata {
  filename: string;
  filesize: number;
  width?: number;
  height?: number;
  mimeType: 'image/jxl';
  url: string;
  externalUrl?: string;
  /** SHA-256 of the JPEG XL bytes. Present on new uploads, optional for legacy records. */
  sha256?: string;
  /** Original JPEG identity, also recorded for new JPEG renditions. */
  originalSha256?: string;
  /** Original JPEG rendition length, or the main upload length for a document record. */
  originalFilesize?: number;
}

export interface JxlSpaceSaverError {
  /** Reason code recorded when Space saver kept the original JPEG. */
  code: 'JXL_PLATFORM' | 'JXL_RECONSTRUCTION' | 'JXL_IO' | 'JXL_INPUT';
  message: string;
}

export interface JxlDocumentMetadata extends JxlRenditionMetadata {
  fidelity: string;
  /** True after the post-commit job verifies and removes the main JPEG original. */
  spaceSaved: boolean;
  originalFilesize: number;
  /** Present when JPEG retirement could not complete and the original was kept. */
  spaceSaverError?: JxlSpaceSaverError;
  sizes: Record<string, JxlRenditionMetadata>;
}

export interface JxlAtomicRestoreUploadArgs {
  collection: SanitizedCollectionConfig;
  data: Record<string, unknown> & {filename: string};
  file: {
    buffer: Buffer;
    filename: string;
    filesize: number;
    mimeType: 'image/jpeg';
  };
  /** Restore maintenance supplies these fields without an end-user HTTP request. */
  req: Pick<PayloadRequest, 'payload' | 'context'>;
}

/** Additional capability on a direct storage adapter that already provides its normal handleUpload function. */
export interface JxlAtomicRestoreCapability {
  /**
   * Atomically create the complete destination only if absent.
   * Return true when created or false when already present without replacement, and throw on failure.
   * Both results require the caller's subsequent SHA-256 and length verification.
   */
  handleUploadIfAbsent(args: JxlAtomicRestoreUploadArgs): boolean | Promise<boolean>;
}

export interface RestoreOriginalsOptions {
  collections?: string | string[];
}

export interface RestoreOriginalsResult {
  /** Number of main JPEG originals newly created during this call. */
  restored: number;
  /** Documents skipped or originals already present, including a verified concurrent publication. */
  skipped: number;
  /** Newly created main JPEG counts by collection slug. */
  collections: Record<string, number>;
}

export interface RestoreLocalOriginalsResult {
  restored: number;
  skipped: number;
}

export declare function jxl(options?: JxlPayloadOptions): ((config: Config) => Config) & {order: number};
export default jxl;

/**
 * Trusted maintenance that restores main JPEGs, verifies publication and conditionally completes document metadata.
 * Cloud writes require JxlAtomicRestoreCapability. Metadata completion requires a conditional database writer.
 * Missing capabilities raise JXL_PLATFORM, and failed completion retains the original and recovery archive.
 */
export declare function restoreOriginals(
  payload: Payload,
  options?: RestoreOriginalsOptions,
): Promise<RestoreOriginalsResult>;

/** Folder recovery without Payload metadata checks or document flag updates. Existing originals and archives are kept. */
export declare function restoreLocalOriginals(
  staticDir: string,
): Promise<RestoreLocalOriginalsResult>;

export declare function varyAccept(headers?: HeadersInit): Headers;
export declare function jxlFilename(filename: string): string | null;
