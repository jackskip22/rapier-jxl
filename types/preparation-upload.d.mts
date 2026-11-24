import type {ImageResult} from './result.mjs';
// Narrow preparation types shared by the upload entry, its codec and private entry composition.
import type {UploadInput, UploadOptions, FitOptions, FitFidelity, PixelFidelity, PreparationInput, TextureInput, Bytes, OutputSize} from './types.mjs';
/** What upload's fit and variants read: one still image, not a texture. */
export type UploadPreparationInput = Exclude<PreparationInput, TextureInput>;
/** fit's options with upload's efforts 1-3, and no firstRegion. */
export type UploadFitOptions = Omit<FitOptions, 'effort' | 'firstRegion' | 'webgpu'> & {
  /** 1 (fastest) to 3 (smallest file). Default 3. */
  effort?: 1 | 2 | 3;
  firstRegion?: never; webgpu?: never};
/** One output of upload's variants: its size, and its own effort (1-3), progressive, JPEG policy, maxBytes or fidelity. */
export type UploadVariantRequest = OutputSize & {effort?: 1 | 2 | 3; /** As encode's progressive. */ progressive?: boolean; /** As encode's JPEG policy. */ jpeg?: 'pixels'; /** true: a side past the source's enlarges. By default it gives the source's. */ upscale?: boolean} & (
  {maxBytes: number; fidelity?: FitFidelity} |
  {maxBytes?: never; fidelity?: PixelFidelity}
);
/** upload's options plus the outputs wanted. */
export type UploadVariantsOptions = UploadOptions & {
  /** One entry per file wanted. */
  outputs: readonly UploadVariantRequest[]};
/** A fit and a variants call over one picture, for a queue that prepares uploads. */
export interface UploadPreparation {
  fit(input: UploadPreparationInput, options: UploadFitOptions): Promise<ImageResult>;
  variants(input: UploadPreparationInput, options: UploadVariantsOptions): Promise<ImageResult[]>;
}
/** Internal entry composition: the supplied encoder writes every file. Hooks are entry-owned implementation wiring. */
export function preparationUpload(encode: (input: UploadInput, options?: UploadOptions) => Promise<Bytes>, hooks?: object): UploadPreparation;
