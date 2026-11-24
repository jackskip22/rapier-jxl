// The types of `?jxl` imports: a file the app's tsconfig includes (npx jpegxl add vite puts it in src/).
declare module '*?jxl' {
  /** The JPEG XL file's URL. */
  const src: string;
  /** The original file's URL, as Vite writes it. */
  export const original: string;
  export default src;
}
// `?w=640&jxl` and `?w=480;960&jxl`: the file at that width, or a srcset list of one file per width.
declare module '*&jxl' {
  /** One width: the JPEG XL file's URL. Several: `url 480w, url 960w`, for a srcset. */
  const src: string;
  /** The original file's URL, as Vite writes it. */
  export const original: string;
  export default src;
}
