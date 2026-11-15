// Copy the built modules unchanged into the package's Web folder. No encoder is compiled by the iOS project.
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const modules = ['upload', 'jpeg', 'animation'];
export async function prepareAssets({example = here, packageDir = process.env.JXL_PACKAGE && resolve(process.env.JXL_PACKAGE)} = {}) {
  const pkg = packageDir || resolve(example, 'node_modules/jpegxl');
  const web = join(example, 'Sources/RapierJXL/Web'), out = join(web, 'jpegxl');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  await mkdir(out, {recursive: true});
  for (const name of modules) {
    const path = `dist/${name}.mjs`;
    if (manifest.exports?.[`./${name}`]?.import !== `./${path}`)
      throw new Error(`JXL_PACKAGE: ${pkg} is not a built package with ./${name}.`);
    await copyFile(join(pkg, path), join(out, `${name}.mjs`));
  }
  await copyFile(join(pkg, 'LICENSE'), join(out, 'LICENSE'));
  const files = [];
  for (const path of ['encoder.html', 'page.mjs', 'encoder.mjs', 'headers.json', ...modules.map(n => `jpegxl/${n}.mjs`), 'jpegxl/LICENSE']) {
    const bytes = await readFile(join(web, path));
    files.push({path, bytes: bytes.length, sha256: digest(bytes)});
  }
  const report = {package: {name: manifest.name, version: manifest.version}, files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0)};
  await mkdir(join(example, 'build'), {recursive: true});
  await writeFile(join(example, 'build/web-assets.json'), JSON.stringify(report, null, 2) + '\n');
  return {web, report};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify((await prepareAssets()).report, null, 2)); }
  catch (error) { console.error(`${error.code || 'JXL_PACKAGE'}: ${error.message}\nSet JXL_PACKAGE to a built package, or run npm install --no-save jpegxl in this example.`); process.exitCode = 1; }
}
