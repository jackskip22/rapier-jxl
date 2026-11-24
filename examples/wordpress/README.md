# JPEG XL Storage for WordPress

A small WordPress plug-in that encodes new image uploads to JPEG XL in the browser using `jpegxl@8.5.0` from jsDelivr inside a web worker. Nothing has to be compiled on the PHP host, and the editor stays responsive while images convert.

## Install

1. Zip this folder (`rapier-jxl.php`, `admin.js`, `front.js`, `README.md`) as `rapier-jxl.zip`.
2. In WordPress 6.8 or later (PHP 7.4 or later), open **Plugins -> Add New Plugin -> Upload Plugin**, upload the zip, and activate **JPEG XL Storage**.
3. Open **Settings -> Media** to choose **JPEG XL storage**.

## Storage modes

### Keep originals (default)

After WordPress creates an uploaded image's sub-sizes, your browser fetches the original and each sub-size and writes a `.jxl` file beside each one. JPEG files are recompressed losslessly (`fidelity: 'exact'`). PNG and WebP files use the encoder's default quality, and screenshots and graphics stay exact automatically.

On the front end, each attachment image with `.jxl` files is wrapped in `<picture>` with `<source type="image/jxl">` carrying the matching `srcset` and `sizes`. Browsers without JPEG XL, link previews, and RSS feeds receive the original file.

### Space saver

Every new JPEG, PNG, and WebP upload and its sub-sizes are stored only as JPEG XL:

- **JPEG:** recompressed losslessly, restored in the worker with `jpegxl/jpeg`, and checked by SHA-256 against the file on the server before removal. JPEG uploads can always be restored to the original JPEG.
- **PNG and WebP:** decoded in the worker and verified pixel for pixel when exact, or against the measured visual quality when lossy, before removal. They come back as a new PNG (when transparent or exact) or JPEG, never the original file.
- **Static fallback:** one verified fallback file per image stays at the `large` size (or the full size when smaller) for link previews, Open Graph (`og:image`), RSS feeds, email, and search crawlers.
- **Browsers without JPEG XL:** checked with `supportsJXL` from `jpegxl/polyfill`. Exact JPEGs are restored with `jpegxl/jpeg` and other images are decoded with `jpegxl/decode`, displayed as a `blob:` URL at the `srcset` size chosen for the screen.
- **Edit Image and Restore originals:** editing an image rebuilds its file on disk through the plug-in's REST route before the editor opens. **Settings -> Media** always offers **Restore originals** with progress while any image is stored as JPEG XL only, and deactivating the plug-in while files are removed warns and links to that button.
- **Cleanup:** deleting an attachment removes all of its `.jxl` files in both modes.

## License

MIT.
