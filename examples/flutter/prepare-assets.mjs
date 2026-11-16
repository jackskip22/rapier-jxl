// Copy the built modules unchanged into the package's web assets. No encoder is compiled by the Flutter project.
import {copyFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// animation.browser.mjs reads a video on the page and runs animation.mjs as its worker.
const modules = ['upload', 'jpeg', 'animation'], browserFiles = ['animation.browser'];
export async function prepareAssets({example = here, packageDir = process.env.JXL_PACKAGE && resolve(process.env.JXL_PACKAGE)} = {}) {
  const pkg = packageDir || resolve(example, 'node_modules/jpegxl');
  const out = join(example, 'assets/web/jpegxl');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  await mkdir(out, {recursive: true});
  for (const name of modules) {
    const path = `dist/${name}.mjs`;
    if (manifest.exports?.[`./${name}`]?.import !== `./${path}`)
      throw new Error(`JXL_PACKAGE: ${pkg} is not a built package with ./${name}.`);
    await copyFile(join(pkg, path), join(out, `${name}.mjs`));
  }
  for (const name of browserFiles) {
    if (manifest.exports?.[`./${name.replace('.browser', '')}`]?.browser !== `./dist/${name}.mjs`)
      throw new Error(`JXL_PACKAGE: ${pkg} has no browser file for ./${name.replace('.browser', '')}.`);
    await copyFile(join(pkg, `dist/${name}.mjs`), join(out, `${name}.mjs`));
  }
  await copyFile(join(pkg, 'LICENSE'), join(out, 'LICENSE'));
  // The tests read an animation back with the package's decoder in the page, and its .wasm names what a host says when it
  // refuses the decoder; the app carries neither.
  if (manifest.exports?.['./decode']?.import !== './dist/decode.mjs') throw new Error(`JXL_PACKAGE: ${pkg} has no ./decode.`);
  for (const name of ['decode.mjs', 'decode.wasm']) await copyFile(join(pkg, 'dist', name), join(example, 'example/assets/fixtures', name));
  return {package: {name: manifest.name, version: manifest.version}};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await prepareAssets())); }
  catch (error) { console.error(`${error.code || 'JXL_PACKAGE'}: ${error.message}\nSet JXL_PACKAGE to a built package, or run npm install --no-save jpegxl in this folder.`); process.exitCode = 1; }
}
