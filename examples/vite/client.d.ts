// The types of `?jxl` imports: a file the app's tsconfig includes (npx jpegxl add vite puts it in src/).
declare module '*?jxl' {
  /** The JPEG XL file's URL. */
  const src: string;
  /** The original file's URL, as Vite writes it. */
  export const original: string;
  export default src;
}
