// Copies the page and the built package's browser files, unchanged, into an app's web folder.
// A photo, a JPEG and a video each run their module in its own worker, so each module goes beside its browser file.
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const names = ['upload', 'jpeg', 'animation'];
export async function prepare({web, packageDir = process.env.JXL_PACKAGE && resolve(process.env.JXL_PACKAGE), app}) {
  const pkg = packageDir || resolve(app, 'node_modules/jpegxl');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  await rm(web, {recursive: true, force: true});
  await mkdir(join(web, 'jpegxl'), {recursive: true});
  for (const name of ['index.html', 'app.mjs']) await copyFile(join(here, name), join(web, name));
  const files = [];
  for (const name of names) for (const file of [`${name}.mjs`, `${name}.browser.mjs`]) {
    if (manifest.exports?.[`./${name}`]?.browser !== `./dist/${name}.browser.mjs`)
      throw Object.assign(new Error(`${pkg} is not a built package with ./${name}.`), {code: 'JXL_PACKAGE'});
    await copyFile(join(pkg, 'dist', file), join(web, 'jpegxl', file));
    files.push(`jpegxl/${file}`);
  }
  await copyFile(join(pkg, 'LICENSE'), join(web, 'jpegxl/LICENSE'));
  const sizes = [];
  for (const path of ['index.html', 'app.mjs', ...files, 'jpegxl/LICENSE']) {
    const bytes = await readFile(join(web, path));
    sizes.push({path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
  }
  const report = {package: {name: manifest.name, version: manifest.version}, files: sizes, totalBytes: sizes.reduce((sum, f) => sum + f.bytes, 0)};
  await writeFile(join(web, '..', 'web-assets.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
