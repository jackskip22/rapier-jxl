import type {ImageResult} from './result.mjs';
// Narrow preparation types shared by the upload entry, its codec and private entry composition.
import type {UploadInput, UploadOptions, FitOptions, FitFidelity, StillFidelity, PreparationInput, TextureInput, Bytes, EmptyFeatures, OutputSize} from './types.mjs';
export type UploadPreparationInput = Exclude<PreparationInput, TextureInput>;
export type UploadFitOptions = Omit<FitOptions, 'effort' | 'features'> & {effort?: 1 | 2 | 3; features?: EmptyFeatures};
export type UploadVariantRequest = OutputSize & {effort?: 1 | 2 | 3; features?: EmptyFeatures} & (
  {maxBytes: number; fidelity?: FitFidelity} |
  {maxBytes?: never; fidelity?: StillFidelity}
);
export type UploadVariantsOptions = UploadOptions & {outputs: readonly UploadVariantRequest[]};
export interface UploadPreparation {
  fit(input: UploadPreparationInput, options: UploadFitOptions): Promise<ImageResult>;
  variants(input: UploadPreparationInput, options: UploadVariantsOptions): Promise<ImageResult[]>;
}
/** Internal entry composition: the supplied encoder writes every file; hooks are entry-owned implementation wiring. */
export function preparationUpload(encode: (input: UploadInput, options?: UploadOptions) => Promise<Bytes>, hooks?: object): UploadPreparation;
