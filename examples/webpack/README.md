# JPEG XL images for webpack and Rspack

A webpack 5 and Rspack plug-in. An image import becomes a JPEG XL file at build. The original stays for browsers that
do not show JPEG XL.

JPEGs come out about a fifth smaller and restore exactly. rapier-jxl is the encoder inside rapier.website, the free
Markdown editor and painting app.

```sh
npm install --save-dev jpegxl
npx jpegxl add webpack
```

`add webpack` copies `rapier-jxl-webpack.mjs` and `rapier-jxl-files.mjs` into the project and adds `jxl()` to `plugins`
in `webpack.config.*` (or `rspack.config.*`). By hand:

```js
// webpack.config.js (or rspack.config.js)
import {jxl} from './rapier-jxl-webpack.mjs';

export default {
  module: {rules: [{test: /\.(png|jpe?g)$/i, type: 'asset/resource'}]},
  plugins: [jxl()],
};
```

```js
import hero, {original} from './hero.jpg?jxl';

element.innerHTML = `<picture>
  <source srcset="${hero}" type="image/jxl">
  <img src="${original}" alt="">
</picture>`;
```

`hero` is the JPEG XL file's URL (with `output.publicPath`). `original` is the original's, through the build's own rule
for images.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `fidelity` | `{quality: 90}` | As rapier-jxl's `encode`, for PNG files: `'exact'` or `{quality}` from 1 to 100. JPEGs without `read` stay exact. |
| `effort` | `3` | 1 (fastest) to 9 (smallest). |
| `beside` | `false` | `true` writes a `.jxl` beside every JPEG and PNG the build emits (`a1b2.jpg` gets `a1b2.jxl`), for a server that picks by `Accept: image/jxl`. A RegExp limits it to the names that match. |
| `read` | none | `(bytes, file) => ({width, height, data})`: decodes any source. JPEGs are then encoded at `fidelity`. |
| `cache` | `true` | Keeps each file in `node_modules/.cache/rapier-jxl`, keyed by the source, these options and the rapier-jxl version. |

Use either `beside` or `?jxl` for a given file. Each writes its own copy.

## With image-minimizer-webpack-plugin

A project that already sets up its images with image-minimizer-webpack-plugin adds JPEG XL as one more generator:

```js
import ImageMinimizerPlugin from 'image-minimizer-webpack-plugin';
import {jxlGenerator} from './rapier-jxl-webpack.mjs';

export default {
  optimization: {minimizer: ['...', new ImageMinimizerPlugin({generator: [{preset: 'jxl', implementation: jxlGenerator()}]})]},
};
```

Then `import hero from './hero.jpg?as=jxl'` is the JPEG XL file's URL. `jxlGenerator` takes the options above but `beside`.

## Errors

A `?jxl` file the encoder refuses stops the build with the file's name, the code and the fix, such as `JXL_MEMORY`
for a picture past the host's memory. A `beside` file that fails is left as it is, with a warning.

A CommonJS config (`module.exports`) loads the plug-in with `require`, which needs Node 22.12 or later. On earlier supported Node versions,
name the config `webpack.config.mjs`.
