# JPEG XL for Payload CMS

Adds JPEG XL companions for supported uploaded images and their generated `imageSizes` renditions, on local disk or through Payload's storage adapters.


```sh
npx jpegxl add payload
```

It installs `jpegxl` if missing, copies the plug-in and `<Picture>` helper into `src/jxl/` (or `jxl/` when `payload.config.ts` sits at the project root), and adds `jxl()` to `plugins` in `payload.config.ts`:

```ts
import {buildConfig} from 'payload';
import {jxl} from './jxl/index.mjs';

export default buildConfig({
  // ...
  plugins: [jxl()],
});
```

Running it again changes nothing, and leaves any file you edited alone.

## Upload encoding and document fields

- JPEGs are recompressed losslessly with `recompress` from `jpegxl/jpeg` and restore the original JPEG exactly.
- PNG, WebP, GIF, AVIF and other supported raster formats use the encoder's default fidelity unless `fidelity` is configured. Non-JPEG decoding may use the `sharp` instance supplied by Payload or the plug-in options.
- Each supported, generated `imageSizes` rendition gets its own companion. `photo.jpg` becomes `photo.jpg.jxl`, and a rendition such as `photo-card.png` becomes `photo-card.png.jxl`.
- The plug-in maintains `doc.jxl` during uploads and restoration. Main and rendition archive names must agree with the corresponding `doc.filename` or `doc.sizes.<name>.filename`.

The generated metadata includes:

| Field | Meaning |
| --- | --- |
| `filename`, `filesize`, `mimeType`, `url` | Companion name, length in bytes, `image/jxl`, and serving URL |
| `width`, `height` | Image dimensions when available |
| `sha256` | Expected SHA-256 of the JPEG XL bytes, recorded for new main images and renditions |
| `originalFilesize` | Original upload length on the main record, also recorded on JPEG rendition records |
| `originalSha256` | Original JPEG SHA-256 on main JPEG and JPEG rendition records |
| `fidelity` | Encoding fidelity recorded on the main image |
| `spaceSaved` | `true` after Space saver verifies and removes the main JPEG original |
| `spaceSaverError` | Code and message recorded when Space saver kept the original JPEG |
| `sizes.<name>` | Companion metadata for a generated rendition |
| `externalUrl` | An adapter-provided external URL when present |

## Space saver

Pass `spaceSaver: true` on `jxl({spaceSaver: true})` (or per collection in `collections`) to keep uploaded JPEGs only as JPEG XL:

```ts
plugins: [jxl({spaceSaver: true})]
```

During the upload request, the plug-in keeps the original JPEG, verifies the written `.jxl`, and queues a `jxl-space-saver` job in Payload's job queue (enabling `payload-jobs` when the project has no jobs yet). If the upload rolls back, no job remains. After the upload commits, running Payload's jobs (`await payload.jobs.run()` or Payload's job runner) reads the committed document, checks that the stored original and `.jxl` still match the upload SHA-256 and restore the original JPEG exactly, removes the main JPEG, and sets `doc.jxl.spaceSaved = true`. Any failure leaves the original in place and records `doc.jxl.spaceSaverError`. Non-JPEG uploads and `imageSizes` renditions keep their originals in this version.

Requests for a removed original on `/api/<collection>/file/<filename>` rebuild the original JPEG from `.jxl` with `Vary: Accept`.

To put every removed original JPEG back, verified, and clear `doc.jxl.spaceSaved`:

```ts
import {restoreOriginals, restoreLocalOriginals} from './jxl/index.mjs';

await restoreOriginals(payload);
```

On cloud storage, `restoreOriginals(payload)` requires an adapter with `handleUploadIfAbsent` so restoration never overwrites a competing upload. For a local upload folder without starting Payload, `await restoreLocalOriginals(staticDir)` writes missing JPEGs back beside their `.jpg.jxl` files without updating database rows.

## Filenames, collisions and cleanup

Local companion publication uses an exclusive write. An existing file with the expected SHA-256 can satisfy a retry. An existing file with different bytes causes `JXL_INPUT`, and symlinks are refused. New content needs a different filename while a different companion occupies the requested name.

Cloud companion uploads reject a different existing companion found during the initial read. Generic adapter upload hooks do not provide an atomic reservation between that read and the write, so this check does not guarantee immutability against concurrent cloud writers. During the upload request itself, originals remain present.

A document whose `spaceSaved` flag is still `true` must be restored before its image can be replaced or cropped. Cleanup considers only companions owned by the document's main image and renditions. When a request has an active transaction, old recovery files are retained through replacement or deletion because the database operation may still roll back. Failed operations can therefore leave recovery files for later cleanup by the host.

## Next.js `<Picture>` and file responses

Render uploads in Next.js with `<Picture>` so every rendition has its own `.jxl` URL and the original stays on `<img>` as fallback:

```tsx
import {Picture} from '@/jxl/picture.mjs';

export function Hero({media}) {
  return <Picture doc={media} alt={media.alt} sizes="100vw" />;
}
```

Pass `size="card"` to render a single named `imageSizes` rendition.

The following behavior applies to the plug-in's Payload file endpoint, `/api/<collection>/file/<filename>`:

- Requests continue through Payload's native upload access check. The selected file must belong to an unambiguous main image or rendition, including when public access requires a separate document lookup.
- An original URL negotiates JPEG XL when the client prefers it. Preview requests and GET byte-range requests retain the original representation.
- An explicit `.jxl` URL requests JPEG XL, including for a preview or byte range, subject to the same ownership and storage access checks.
- Responses vary on `Accept`, `Range`, `User-Agent`, `Purpose`, `Sec-Purpose` and `X-Purpose`. Existing Vary fields and wildcard semantics are preserved. Caches must honor those fields.
- Stored archive hashes and lengths are checked when recorded. JPEG archives also reconstruct and check the recorded original identity before either representation is returned. Mismatches produce coded refusals.
- Strong ETags for each representation support `If-Match`, `If-None-Match` and `If-Range`. GET supports a single byte range, including suffix and open ranges. HEAD has no body and ignores Range. Unsupported range units are ignored. Unsatisfiable byte ranges return 416, a matching `If-None-Match` returns 304, and a failed `If-Match` returns 412.
- `If-Range` requires the current strong ETag. A different, weak or date-based validator produces the full representation because this path does not advertise Last-Modified.
- Cloud adapter denials are preserved, including missing-original responses marked `private`, `no-store` or `no-cache`, or carrying Set-Cookie. An archive cannot replace them with a successful response. Authorization and Cookie headers remain available to the adapter, and archive output cannot relax the original storage privacy policy.

Archive verification requires complete stored-file reads and, for JPEG archives, reconstruction of the original. These checks also apply to HEAD and conditional responses. Cloud reads stop when a body exceeds its recorded length. Legacy records without a recorded length still require a complete read.

If an adapter supplies `externalUrl`, the picture helper can link directly to that provider. Payload endpoint negotiation, verification and response headers do not apply to requests that bypass Payload. The provider's access and cache configuration governs those URLs.
