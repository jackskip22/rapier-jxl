# Adding JPEG XL images to a webpack or Rspack project

## Wire it

In the folder with the project's `package.json`:

```sh
npm install --save-dev jpegxl
npx jpegxl add webpack --dry-run --json   # what it would change
npx jpegxl add webpack --json
```

It copies `rapier-jxl-webpack.mjs` and `rapier-jxl-files.mjs` and adds `jxl()` to `plugins` in `webpack.config.*` or
`rspack.config.*` (ES module or CommonJS). Running it again changes nothing. If it stops with `JXL_SETUP` (a TypeScript
config, or `plugins` built by a function), make the edit its `Fix:` names. The config was left as it was.

Then, where a page shows a photograph:

```js
import hero, {original} from './hero.jpg?jxl';
// <picture><source srcset={hero} type="image/jxl"><img src={original} alt="..."></picture>
```

For a site whose server picks files by `Accept: image/jxl`, pass `jxl({beside: true})` instead of using `?jxl`.

If the config already uses image-minimizer-webpack-plugin, add `{preset: 'jxl', implementation: jxlGenerator()}` to its
`generator` list instead (README) and import with `?as=jxl`. Do not add `jxl()` as well.

## Check it worked

- The build lists a `.jxl` asset for each `?jxl` import (and, with `beside`, one beside each emitted JPEG and PNG).
- For a JPEG source, `djxl hero.<hash>.jxl out.jpg` gives a file identical to the original (`cmp`).

## Do not

- Do not replace the `<img>` original with the `.jxl` URL: Edge and older browsers show nothing.
- Do not add a module rule for `?jxl`: the plug-in adds its own.
- Do not edit the copied files to change options. Pass them: `jxl({effort: 5, fidelity: {quality: 85}})`.
- Do not use both `beside` and `?jxl` for the same file: each writes its own copy.
