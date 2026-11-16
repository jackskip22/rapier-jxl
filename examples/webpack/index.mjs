// SPDX-License-Identifier: MIT
// JPEG XL images for webpack 5 and Rspack. `import hero, {original} from './hero.jpg?jxl'` gives the URL of a JPEG XL
// file written at build and the original's; `beside: true` writes a .jxl beside every JPEG and PNG the build emits, for
// a server that picks by `Accept: image/jxl`. The original stays as it was. This file is the plug-in and its loader.
import {basename, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {IMAGE, jxlFiles, jxlName} from '../files/index.mjs';

const QUERY = /(?:^\?|&)jxl(?:&|$)/;
const LOADER = fileURLToPath(import.meta.url);
const NAME = 'rapier-jxl';
const shared = new Map(); // compiler -> {toJxl}; the plug-in hands its options to its loader through this

/** @param {import('./index.d.ts').JxlOptions} [options] */
export function jxl(options = {}) {
  const {fidelity, effort = 3, read, cache = true, beside = false} = options;
  return {
    apply(compiler) {
      const cacheDir = cache ? join(compiler.options.context || process.cwd(), 'node_modules', '.cache', NAME) : undefined;
      const files = jxlFiles({fidelity, effort, read, cacheDir});
      shared.set(compiler.root ?? compiler, files);
      // `?jxl` imports: this file is the loader; the module is JavaScript whatever other rules say of images.
      compiler.options.module.rules.push({resourceQuery: QUERY, type: 'javascript/auto', use: [{loader: LOADER}]});
      if (!beside) return;
      const {Compilation, sources} = compiler.webpack;
      compiler.hooks.thisCompilation.tap(NAME, compilation => {
        compilation.hooks.processAssets.tapPromise({name: NAME, stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE}, async assets => {
          const test = beside instanceof RegExp ? beside : IMAGE;
          const jobs = Object.keys(assets).filter(name => IMAGE.test(name) && test.test(name) && !assets[jxlName(name)]).map(name => {
            const info = compilation.getAsset(name)?.info ?? {};
            const source = info.sourceFilename ?? name;
            return files.toJxl(source, {bytes: assets[name].buffer()}).then(
              out => compilation.emitAsset(jxlName(name), new sources.RawSource(Buffer.from(out.bytes)), {minimized: true, related: {original: name}}),
              error => compilation.warnings.push(new compiler.webpack.WebpackError(`rapier-jxl left ${name} as it is: ${error.code || ''} ${error.message}`)));
          });
          await Promise.all(jobs);
        });
      });
    },
  };
}

/** A generator for image-minimizer-webpack-plugin, where many webpack projects already set up their images:
 * `generator: [{preset: 'jxl', implementation: jxlGenerator({effort: 3})}]`, then `import hero from './hero.jpg?as=jxl'`.
 * @param {import('./index.d.ts').JxlOptions} [options] */
export function jxlGenerator({fidelity, effort = 3, read, cache = true} = {}) {
  const files = jxlFiles({fidelity, effort, read, cacheDir: cache ? join(process.cwd(), 'node_modules', '.cache', NAME) : undefined});
  return async original => {
    if (!IMAGE.test(original.filename)) return null;
    try {
      const out = await files.toJxl(original.filename, {bytes: original.data});
      return {filename: jxlName(original.filename), data: Buffer.from(out.bytes), warnings: [...original.warnings], errors: [...original.errors],
        info: {...original.info, generated: true, generatedBy: [NAME]}};
    } catch (error) {
      original.errors.push(new Error(`rapier-jxl could not write ${original.filename}: ${error.code || ''} ${error.message}`));
      return null;
    }
  };
}

// The loader for `?jxl` (this file's default export, as webpack and Rspack read loaders): emits the JPEG XL file and
// exports its URL, and the original's through the build's own rules for images.
export default async function loader(content) {
  const callback = this.async();
  const file = this.resourcePath;
  try {
    if (!IMAGE.test(file)) throw Object.assign(new Error("Unsupported format; use a JPEG or PNG."), {code: 'JXL_INPUT'});
    const files = shared.get(this._compiler?.root ?? this._compiler) ?? jxlFiles();
    const out = await files.toJxl(file, {bytes: content});
    const outName = jxlName(basename(file)).replace(/\.jxl$/, `.${out.key.slice(0, 8)}.jxl`);
    this.emitFile(outName, Buffer.from(out.bytes));
    const original = JSON.stringify('./' + basename(file));
    callback(null, `export default __webpack_public_path__ + ${JSON.stringify(outName)};\nexport {default as original} from ${original};\n`);
  } catch (error) {
    callback(new Error(`rapier-jxl could not write ${relative(this.rootContext || process.cwd(), file)}: ${error.code || ''} ${error.message} Fix: import it without ?jxl to serve the original.`));
  }
}
export const raw = true;
