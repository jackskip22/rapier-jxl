# rapier-jxl in iOS

Write JPEG XL from Swift with no native code. A hidden `WKWebView` runs the encoder in a worker and the package serves its own
files to it from the app bundle. Nothing touches the network. iOS 17 and later decode JPEG XL natively (`UIImage(data:)`,
Safari); iOS has no encoder, and this is one.

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
let moving = try await codec.animate(gif: gifData)                  // an animated JPEG XL
let shown = UIImage(data: jxl)                                      // iOS 17 and later
```

Each call runs one at a time. Cancel a call by canceling its `Task`; the next call runs normally. A refusal throws
`JXLError` with the package's own `JXL_` code.

## Files

- `Sources/RapierJXL/RapierJXL.swift`: `JXLCodec`, the five calls.
- `Sources/RapierJXL/Bridge.swift`: serves the bundle and carries bytes as HTTP bodies, `/in/<id>` and `/out/<id>/result`. No base64.
- `Sources/RapierJXL/Web/`: the page, its worker, and (after `prepare-assets.mjs`) the modules.
- `Example/`: a SwiftUI app that picks a photo, writes JPEG XL, shows it, and shares it. `xcodegen` builds its project.
- `Tests/`: `xcodebuild test -scheme RapierJXL -destination 'platform=iOS Simulator,name=iPhone 16' (or id=<simulator>)`.

## Asset bytes

Measured on Linux x64 with Node 24 and an 8.4.0 package. Brotli 11, window 24 (the app's download is compressed; the
bundle on disk is not).

| Module | Bytes | Brotli 11 |
| --- | ---: | ---: |
| `upload.mjs` (photos) | 1,058,847 | 332,209 |
| `jpeg.mjs` (recompress, restore) | 528,099 | 166,434 |
| `animation.mjs` (GIF) | 1,623,163 | 494,966 |
| Page, worker, headers, license | 4,766 | |
| Total | 3,214,875 | |

## Check

The WebKit proof script runs the same page and worker in WebKit against the built package, with a local
server in the place of Swift: photo, exact JPEG restore, GIF, refusal, cancel, and the next call. The Swift side runs on a
macOS runner (`ci/ios.yml`). A phone checks the real picker and share sheet.

On the simulator, ImageIO read one of the two frames of an animated JPEG XL; the package's decoder, run in Node on the bytes
WebKit wrote, reads both frames and their delays.
