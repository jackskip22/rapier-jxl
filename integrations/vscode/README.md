# JPEG XL Convert

Convert and compress PNG, JPEG, WebP and GIF files to JPEG XL from the Explorer. Offline; nothing leaves your machine.

JPEG XL (`.jxl`) is a modern image format. Chrome and Firefox show it by default since October 2026, and Safari since 17.
It is good for three things today:

- **JPEGs, lossless.** About 20% smaller, and the original JPEG comes back byte for byte.
- **Screenshots and graphics, exact.** Every pixel kept, 86 to 93% smaller than the PNG.
- **Photographs, by look.** One quality number, 1 to 100.

Built on [rapier-jxl](https://github.com/jackskip22/rapier-jxl), an MIT-licensed JPEG XL encoder in WebAssembly.

## Commands

- **Convert to JPEG XL**: right-click files or a folder in the Explorer. `name.jxl` is written beside each file.
  Existing files are never replaced. Every new file is decoded and compared with its original first: a file that
  fails the check is not written, and the message says why. Where an editor cannot run the check, the file is written
  and the message says it was not checked.
- **Compare with Original**: the picture and its `.jxl` side by side or with a slider, with both sizes.
- **Convert JPEG XL Back**: to PNG, or to the original JPEG where the file came from one.

Opening a `.jxl` file shows the picture, its size and its dimensions.

## Settings

| Setting | Default | |
|---|---|---|
| `jxl.quality` | 90 | How the picture looks, 1 to 100. Not a bit rate. |
| `jxl.exact` | `auto` | `auto` keeps screenshots and graphics exact and uses quality for photographs. |
| `jxl.effort` | 7 | 1 is fastest, 9 is smallest. |
| `jxl.reencodeJpeg` | off | Re-encode JPEGs at the quality above instead of recompressing them losslessly. |
| `jxl.trashOriginal` | off | Move each original to the trash once its `.jxl` is written and checked. With no trash (VS Code for the Web), it stays. |

## Privacy

No network calls, no telemetry, no remote content. Works offline, in VS Code and on vscode.dev.
