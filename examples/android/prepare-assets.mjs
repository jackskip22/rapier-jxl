// Copy the built modules unchanged: photos, JPEG, and animation (a video is read on the page, encoded in its worker). No encoder is compiled by the Android project.
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareAssets({example = here, packageDir = process.env.JXL_PACKAGE && resolve(process.env.JXL_PACKAGE)} = {}) {
  const pkg = packageDir || resolve(example, 'node_modules/jpegxl');
  const source = join(example, 'app/src/main/assets'), generated = join(example, 'app/build/generated/encoder-assets');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  await mkdir(join(generated, 'jpegxl'), {recursive: true});
  for (const name of ['upload', 'jpeg']) {
    const path = `dist/${name}.mjs`;
    if (manifest.exports?.[`./${name}`]?.import !== `./${path}`)
      throw new Error(`JXL_PACKAGE: ${pkg} is not a built package with ./${name}.`);
    await copyFile(join(pkg, path), join(generated, 'jpegxl', `${name}.mjs`));
  }
  if (manifest.exports?.['./animation']?.browser !== './dist/animation.browser.mjs' || manifest.exports['./animation'].import !== './dist/animation.mjs')
    throw new Error(`JXL_PACKAGE: ${pkg} is not a built package with ./animation.`);
  for (const name of ['animation', 'animation.browser']) await copyFile(join(pkg, `dist/${name}.mjs`), join(generated, 'jpegxl', `${name}.mjs`));
  await copyFile(join(pkg, 'LICENSE'), join(generated, 'jpegxl/LICENSE'));
  const page = await readFile(join(source, 'encoder.html'), 'utf8');
  const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('JXL_ASSETS: The encoder page has no module.');
  const hash = createHash('sha256').update(script).digest('base64');
  const headers = {
    'Content-Security-Policy': `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-${hash}'; worker-src 'self'; connect-src 'self' blob:; img-src 'self' blob: data:; media-src blob:; base-uri 'none'; frame-ancestors 'none'`,
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'
  };
  await writeFile(join(generated, 'headers.json'), JSON.stringify(headers, null, 2) + '\n');
  const files = [];
  for (const [root, paths] of [[source, ['encoder.html', 'encoder.mjs']], [generated, ['jpegxl/upload.mjs', 'jpegxl/jpeg.mjs', 'jpegxl/animation.mjs', 'jpegxl/animation.browser.mjs', 'jpegxl/LICENSE', 'headers.json']]]) {
    for (const path of paths) {
      const bytes = await readFile(join(root, path));
      files.push({path, bytes: bytes.length, sha256: digest(bytes)});
    }
  }
  const report = {package: {name: manifest.name, version: manifest.version, manifestSha256: digest(await readFile(join(pkg, 'package.json')))},
    measurement: 'Uncompressed APK assets; excludes Android code, WebKit, and ZIP overhead.', files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0)};
  await mkdir(join(example, 'build'), {recursive: true});
  await writeFile(join(example, 'build/encoder-assets.json'), JSON.stringify(report, null, 2) + '\n');
  return {source, generated, headers, report};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify((await prepareAssets()).report, null, 2)); }
  catch (error) { console.error(`${error.code || 'JXL_PACKAGE'}: ${error.message}\nSet JXL_PACKAGE to a built package, or run npm install --no-save jpegxl in this example.`); process.exitCode = 1; }
}
