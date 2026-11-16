# rapier-jxl in Android

Pick a photo or share one into the app. Encode at quality 80, effort 3, save a `.jxl` with the system picker, and share it.
The second action recompresses a JPEG, restores it, and compares the original and restored SHA-256 in Kotlin.
The third turns videos into animated JPEG XL: every frame the WebView plays, each with its own time.

One activity. A hidden WebView runs the encoder in a worker. No NDK, native libraries, analytics, or Internet permission.
Native code is faster; rapier-jxl needs none.

## Run

Use Android Studio with SDK 37, JDK 17, and Node installed. Gradle downloads build dependencies once; the app runs offline.
From this folder:

```sh
npm install --no-save jpegxl
./gradlew assembleDebug
```

Open this folder in Android Studio and run on a phone. The APK is `app/build/outputs/apk/debug/app-debug.apk`.
For a local package build, set `JXL_PACKAGE` to its directory containing `package.json` and `dist/` before Gradle runs.

Android 8.0 (API 26) or newer. Binary messages need [WebView 116 or newer](https://developer.android.com/jetpack/androidx/releases/webkit#1.8.0-alpha01)
and `WEB_MESSAGE_ARRAY_BUFFER`; the app checks the feature and shows `JXL_WEBVIEW_BINARY_UNAVAILABLE` when absent.
The WebView version, not the Android version alone, determines support. No base64 crosses this bridge.

## Three files

- `app/src/main/java/app/rapier/jxlexample/MainActivity.kt`: pickers, binary port, hash comparison, save, and Share.
- `app/src/main/assets/encoder.html`: passes messages between Kotlin and the worker, and reads a video with `jpegxl/animation`.
- `app/src/main/assets/encoder.mjs`: the public `encode`, `recompress`, and `restore` calls.

`prepare-assets.mjs` copies the built upload, JPEG and animation modules unchanged. `WebViewAssetLoader` serves them from
`https://appassets.androidplatform.net/assets/`, with JavaScript MIME types and a policy allowing local scripts and WebAssembly.

## Asset bytes

Uncompressed APK assets, measured on Linux x64 with Node 24 and an 8.4.0 package:

| Asset | Bytes |
| --- | ---: |
| Upload module | 1,058,059 |
| JPEG module | 527,025 |
| Animation module and its page file | 1,692,326 |
| Page, worker, headers, and license | 6,567 |
| Total | 3,283,977 |

These are asset bytes, not the APK download size;
Android code, WebKit, and ZIP overhead are excluded. Run `node prepare-assets.mjs` to measure your package;
`build/encoder-assets.json` records every full hash and byte count.

## Check

`./gradlew testDebugUnitTest` checks Kotlin message handling and JPEG hash matching. Without an Android SDK,
`KOTLINC=/path/to/kotlinc bash test-jvm.sh` runs the same checks on a JVM.

The package release check runs this page and its worker in Chromium against the built modules. That checks binary
messages, encoded bytes, restored bytes, a video read back frame by frame, refusals, and local-only requests. A phone checks the real WebView, pickers,
incoming shares, saved-file sharing, rotation, and backgrounding.
