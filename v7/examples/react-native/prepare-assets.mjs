// Copies the built modules unchanged into src/generated as strings the app bundles, and writes the hidden page.
// No encoder is compiled by this project. Run: JXL_PACKAGE=<built package> node prepare-assets.mjs
// (or `npm install --no-save jpegxl` here and run it with no variable).
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ORIGIN = 'https://rapier.invalid/';
// The modules the page loads, by name: [name, the package's export, its file].
const modules = [['upload', './upload', 'dist/upload.mjs'], ['jpeg', './jpeg', 'dist/jpeg.mjs'],
  ['animation', './animation', 'dist/animation.mjs'], ['animation.browser', './animation', 'dist/animation.browser.mjs']];
const names = {upload: 'upload', jpeg: 'jpeg', animation: 'animation', 'animation.browser': 'animationBrowser'};

export async function prepareAssets({example = here, packageDir = process.env.JXL_PACKAGE && resolve(process.env.JXL_PACKAGE)} = {}) {
  const pkg = packageDir || resolve(example, 'node_modules/jpegxl');
  const out = join(example, 'src/generated');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  await mkdir(out, {recursive: true});
  const files = [];
  for (const [name, entry, path] of modules) {
    const found = manifest.exports?.[entry];
    if (found?.import !== `./${path}` && found?.browser !== `./${path}`)
      throw Object.assign(new Error(`${pkg} is not a built package with ${entry}.`), {code: 'JXL_PACKAGE'});
    const text = await readFile(join(pkg, path), 'utf8');
    files.push({name, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex')});
    await writeFile(join(out, `${names[name]}.ts`), `// ${path} of ${manifest.name} ${manifest.version}, unchanged. Written by prepare-assets.mjs.\nexport default ${JSON.stringify(text)};\n`);
  }
  await copyFile(join(pkg, 'LICENSE'), join(out, 'LICENSE'));
  const worker = await readFile(join(here, 'web/worker.js'), 'utf8');
  const script = (await readFile(join(here, 'web/page.js'), 'utf8')).replace('WORKER_SOURCE', JSON.stringify(worker));
  const csp = [`default-src 'none'`, `script-src 'sha256-${createHash('sha256').update(script).digest('base64')}' blob: 'wasm-unsafe-eval'`,
    `worker-src blob:`, `connect-src blob:`, `img-src blob: data:`, `media-src blob:`, `base-uri 'none'`].join('; ');
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>rapier-jxl</title><script>${script}</script>`;
  await writeFile(join(out, 'page.ts'), `// Written by prepare-assets.mjs.
export const ORIGIN = ${JSON.stringify(ORIGIN)};
export const PAGE = ${JSON.stringify(html)};
export const modules: Record<string, () => Promise<string>> = {
${modules.map(([name]) => `  ${JSON.stringify(name)}: () => import('./${names[name]}.ts').then(m => m.default)`).join(',\n')}
};
`);
  const report = {package: {name: manifest.name, version: manifest.version}, files, pageBytes: Buffer.byteLength(html),
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0) + Buffer.byteLength(html)};
  await mkdir(join(example, 'build'), {recursive: true});
  await writeFile(join(example, 'build/assets.json'), JSON.stringify(report, null, 2) + '\n');
  return {out, report};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify((await prepareAssets()).report, null, 2)); }
  catch (error) { console.error(`${error.code || 'JXL_PACKAGE'}: ${error.message}\nSet JXL_PACKAGE to a built package, or run npm install --no-save jpegxl in this example.`); process.exitCode = 1; }
}
