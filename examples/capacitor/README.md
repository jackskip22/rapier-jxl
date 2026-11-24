# rapier-jxl in Capacitor

Choose a photo to encode at quality 80, effort 3, or recompress a JPEG and check its restored SHA-256.
The encoder runs in web workers. Only Capacitor's [Filesystem](https://capacitorjs.com/docs/apis/filesystem) plug-in writes the file. No codec bridge.
Install Node 22.12 or newer and Android Studio, then run `npm install` here.
Run `JXL_PACKAGE=/absolute/path/to/built-package npm run build`. An installed package's example finds its package automatically.
Run `npm run android` once, then `npm run sync` and `npm run open`. Run the app in Android Studio.
Each result is saved in the app's private data directory under a new name. The page shows the path.
Share uses the browser's Web Share API and reports `JXL_SHARE_UNAVAILABLE` when file sharing is unavailable.
Encoding works offline. Native code is faster, and rapier-jxl needs none. Filesystem's native API accepts binary as base64.
