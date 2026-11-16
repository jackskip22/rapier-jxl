// SPDX-License-Identifier: MIT
// JPEG XL images for Vite 6, 7 and 8: `import hero from './hero.jpg?jxl'` gives the URL of a JPEG XL file written at build
// (served on demand in dev), and `folder` writes a .jxl beside every image of a folder. The original stays as it was.
import {createHash} from 'node:crypto';
import {access, mkdir, readdir, realpath, writeFile} from 'node:fs/promises';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {IMAGE, jxlFiles, jxlName} from '../files/index.mjs';

const QUERY = /[?&]jxl(?:&|$)/, DEV = '/@rapier-jxl/';

/** @param {import('./index.d.ts').JxlOptions} [options] */
export function jxl(options = {}) {
  const {fidelity, effort = 3, folder = [], read, cache = true} = options;
  const folders = [folder].flat();
  let config, toJxl;
  const dev = new Map(); // dev URL -> source path

  const fail = (ctx, file, error) => ctx.error(`rapier-jxl could not write ${relative(config.root, file)}: ${error.code || ''} ${error.message} Fix: import it without ?jxl, or leave it out of the folder, to serve the original.`);
  const withinDir = (dir, file) => (file + sep).startsWith(dir + sep);
  const inFolder = file => folders.some(f => withinDir(resolve(config.root, f), file)) && IMAGE.test(file);
  async function realInsideFolder(file) {
    if (!inFolder(file)) return false;
    const real = await realpath(file).catch(() => null);
    if (!real) return false;
    const roots = await Promise.all(folders.map(f => realpath(resolve(config.root, f)).catch(() => resolve(config.root, f))));
    return roots.some(r => withinDir(r, real));
  }
  async function besideSource(path) {
    for (const root of [config.root, config.publicDir].filter(Boolean))
      for (const ext of ['.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG']) {
        const file = join(root, path.slice(0, -4) + ext);
        if (await access(file).then(() => true, () => false) && await realInsideFolder(file)) return file;
      }
  }

  return {
    name: 'rapier-jxl',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
      ({toJxl} = jxlFiles({fidelity, effort, read, cacheDir: cache ? join(config.cacheDir, 'rapier-jxl') : undefined}));
    },
    async load(id) {
      if (!QUERY.test(id)) return;
      const file = id.slice(0, id.indexOf('?'));
      if (!IMAGE.test(file)) return;
      this.addWatchFile(file);
      const original = `export {default as original} from ${JSON.stringify(file)};`;
      if (config.command === 'serve') {
        const url = DEV + createHash('sha256').update(file).digest('hex').slice(0, 16) + '/' + jxlName(basename(file));
        dev.set(url, file);
        return `export default ${JSON.stringify(config.base.replace(/\/$/, '') + url)};\n${original}`;
      }
      let out;
      try { out = await toJxl(file); } catch (error) { fail(this, file, error); return null; }
      if (!out) return null;
      const ref = this.emitFile({type: 'asset', name: jxlName(basename(file)), source: out.bytes});
      // Vite's own asset placeholder: the URL comes out as Vite writes the original's (base, renderBuiltUrl).
      return `export default "__VITE_ASSET__${ref}__";\n${original}`;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // Only this site's paths, under its base; a path that does not decode is not one of ours.
        const raw = (req.url || '').split('?')[0], base = config.base.endsWith('/') ? config.base : config.base + '/';
        if (!raw.startsWith(base)) return next();
        let path;
        try { path = decodeURIComponent('/' + raw.slice(base.length)); } catch { return next(); }
        let file = dev.get(path);
        // folder: /photos/a.jxl beside /photos/a.jpg (or .jpeg, .png), from the source or the public folder.
        if (!file && path.endsWith('.jxl') && folders.length) file = await besideSource(path);
        if (!file) return next();
        try {
          const {bytes, key} = await toJxl(file);
          res.setHeader('Content-Type', 'image/jxl');
          res.setHeader('ETag', '"' + key.slice(0, 32) + '"');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(bytes);
        } catch (error) {
          server.config.logger.error(`rapier-jxl could not write ${relative(config.root, file)}: ${error.code || ''} ${error.message}`);
          res.statusCode = 500; res.end();
        }
      });
    },
    // folder: every image of the folder that the bundle carries gets a .jxl beside it, named as Vite named it.
    async generateBundle(_, bundle) {
      if (!folders.length) return;
      const jobs = [];
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset') continue;
        for (const name of asset.originalFileNames || []) {
          const file = resolve(config.root, name);
          if (!inFolder(file)) continue;
          jobs.push(toJxl(file).then(out => this.emitFile({type: 'asset', fileName: jxlName(asset.fileName), source: out.bytes}),
            error => this.warn(`rapier-jxl left ${name} as it is: ${error.code || ''} ${error.message}`)));
          break;
        }
      }
      await Promise.all(jobs);
    },
    // folder inside publicDir: Vite copies those files as they are, so the .jxl is written beside each copy.
    async writeBundle() {
      if (!folders.length || !config.publicDir || !config.build.copyPublicDir) return;
      const out = resolve(config.root, config.build.outDir);
      for (const f of folders.map(f => resolve(config.root, f)).filter(f => (f + sep).startsWith(config.publicDir + sep))) {
        let names;
        try { names = await readdir(f, {recursive: true}); } catch { continue; }
        for (const name of names.filter(n => IMAGE.test(n))) {
          const file = join(f, name), to = join(out, relative(config.publicDir, jxlName(file)));
          if (!await realInsideFolder(file)) continue;
          try { const {bytes} = await toJxl(file); await mkdir(dirname(to), {recursive: true}); await writeFile(to, bytes); }
          catch (error) { config.logger.warn(`rapier-jxl left ${relative(config.root, file)} as it is: ${error.code || ''} ${error.message}`); }
        }
      }
    },
  };
}
export default jxl;
