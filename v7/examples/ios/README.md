# rapier-jxl in iOS

A Swift wrapper around the browser encoder in a `WKWebView`: no native JPEG XL codec to build or link. It turns videos into
animated JPEG XL, encodes a photo, recompresses a JPEG and restores the same SHA-256, turns a GIF into an animated JPEG XL,
keeps every sample of an opaque photo in exact mode, cancels a call, and refuses bad input with the package's `JXL_` code. On the iPhone 17 Pro simulator (iOS 26.2),
`UIImage` decodes the result and ImageIO shows an animation's first frame.

The files under `Sources/RapierJXL/Web` are 3,283,824 bytes. Brotli 11 module sizes, not install sizes: photos 331,753 B,
JPEG 166,151 B, animation 497,163 B and its page file 19,599 B. Nothing here claims speed.

## Use

iOS 16.4 or newer, Swift 5.9, Xcode 15.

```sh
npm install --no-save jpegxl
node prepare-assets.mjs          # copies the built modules into Sources/RapierJXL/Web/jpegxl
```

Add this folder to your app as a local Swift package (File, Add Package Dependencies, Add Local) and import `RapierJXL`.
For a local package build, set `JXL_PACKAGE` to its directory containing `package.json` and `dist/` first.

```swift
import RapierJXL

let codec = JXLCodec()
let jxl = try await codec.encode(photo, quality: 80, effort: 3)     // UIImage or Data in, JPEG XL Data out
let exact = try await codec.encodeExact(photo)                      // every pixel kept
let small = try await codec.recompress(jpeg: jpegData)              // a JPEG's own bytes, smaller
let same = try await codec.restore(small)                           // the same JPEG, byte for byte
let clip = try await codec.animate(video: movieURL)                 // a video: every frame, each with its time
let moving = try await codec.animate(gif: gifData)                  // a GIF, with its timing and loops
let shown = UIImage(data: jxl)                                      // iOS 17 and later
```

The page plays a video to read its frames, so any video WebKit plays works (`animate(video: Data, type: "video/mp4")` takes bytes).
`animate` reports progress from 0 to 1 through its `progress` closure. Each call runs one at a time. Cancel a call by canceling its `Task`; the next call runs normally. A refusal throws
`JXLError` with the package's own `JXL_` code. A page that stops (iOS can end its process) refuses the call with `JXL_BRIDGE`, and the next call starts a new page.

## Files

- `Sources/RapierJXL/RapierJXL.swift`: `JXLCodec` and its calls.
- `Sources/RapierJXL/Bridge.swift`: serves the bundle and carries bytes as HTTP bodies, `/in/<id>` and `/out/<id>/result`. No base64.
- `Sources/RapierJXL/Web/`: the page (videos and GIFs), its worker (photos and JPEGs), and (after `prepare-assets.mjs`) the modules.
- `Example/`: a SwiftUI app that picks a video, photo or GIF, writes JPEG XL, shows it, and shares it. `xcodegen` builds its project.
- `Tests/`: `xcodebuild test -scheme RapierJXL -destination 'platform=iOS Simulator,name=iPhone 16' (or id=<simulator>)`.

## Asset bytes

Measured on Linux x64 with Node 24 and an 8.4.0 package (16 Nov). Brotli 11, window 24 (the app's download is compressed; the
bundle on disk is not).

| Module | Bytes | Brotli 11 |
| --- | ---: | ---: |
| `upload.mjs` (photos) | 1,058,059 | 331,753 |
| `jpeg.mjs` (recompress, restore) | 527,025 | 166,151 |
| `animation.mjs` (videos, GIFs) | 1,630,990 | 497,163 |
| `animation.browser.mjs` (reads a video on the page) | 61,336 | 19,599 |
| Page, worker, headers, license | 6,414 | |
| Total | 3,283,824 | |

## Check

The WebKit proof script runs the same page and worker in WebKit against the built package, with a local
server in the place of Swift: photo, exact JPEG restore, GIF, video, refusal, cancel, and the next call. The Swift side runs on a
macOS runner (`ci/ios.yml`). A phone checks the real picker and share sheet.

On the simulator, ImageIO read one of the two frames of an animated JPEG XL; the package's decoder, run in Node on the bytes
WebKit wrote, reads both frames and their delays.
