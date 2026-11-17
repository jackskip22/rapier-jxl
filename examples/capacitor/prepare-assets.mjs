// Copies the built package's browser modules, unchanged, beside the page: the Vite build puts them in dist/jpegxl,
// and `npx jpegxl add capacitor` in the project's rapier-jxl folder. Each module runs its encoder in a worker, so a
// module goes beside its browser file.
import {copyFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MODULES = ['upload.mjs', 'upload.browser.mjs', 'jpeg.mjs', 'jpeg.browser.mjs'];

export async function copyModules({packageDir, to}) {
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8').catch(() => 'null') ?? 'null');
  for (const name of ['upload', 'jpeg']) if (manifest?.exports?.[`./${name}`]?.browser !== `./dist/${name}.browser.mjs`)
    throw Object.assign(new Error(`${packageDir} is not a built package with ./${name}.`), {code: 'JXL_PACKAGE'});
  await mkdir(to, {recursive: true});
  for (const name of MODULES) await copyFile(join(packageDir, 'dist', name), join(to, name));
  await copyFile(join(packageDir, 'LICENSE'), join(to, 'LICENSE'));
}

export async function prepareAssets({example = here, packageDir = process.env.JXL_PACKAGE && resolve(process.env.JXL_PACKAGE)} = {}) {
  await copyModules({packageDir: packageDir || resolve(example, 'node_modules/jpegxl'), to: join(example, 'jpegxl')});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await prepareAssets(); }
  catch (error) { console.error(`${error.code || 'JXL_PACKAGE'}: ${error.message}\nSet JXL_PACKAGE to a built package, or run npm install --no-save jpegxl in this example.`); process.exitCode = 1; }
}
