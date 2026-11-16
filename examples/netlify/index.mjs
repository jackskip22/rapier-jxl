// SPDX-License-Identifier: MIT
// Netlify build plug-in: after the site's build, every JPEG and PNG in the publish folder gets a .jxl beside it
// (hero.jpg -> hero.jxl; a JPEG kept exactly), and an edge function that answers browsers sending
// `Accept: image/jxl` with it. Netlify's redirects cannot match a request header, so the choice is the edge function's.
// The originals stay as they were and every other browser gets them.
import {access, mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {join, sep} from 'node:path';
import {IMAGE, jxlFiles, jxlName} from '../files/index.mjs';

const EDGE = 'rapier-jxl.mjs';

export const onBuild = async ({constants, inputs = {}, utils}) => {
  const publish = constants.PUBLISH_DIR;
  const effort = inputs.effort === undefined ? 3 : Number(inputs.effort);
  const fidelity = String(inputs.exact) === 'true' ? 'exact' : inputs.quality === undefined ? undefined : {quality: Number(inputs.quality)};
  const cacheDir = join(constants.CACHE_DIR ?? '.netlify/cache', 'rapier-jxl');
  // Netlify keeps CACHE_DIR between deploys only through utils.cache: restore it, encode what changed, save it.
  if (utils?.cache) await utils.cache.restore(cacheDir);
  const {toJxl} = jxlFiles({fidelity, effort, cacheDir});
  let names;
  try { names = await readdir(publish, {recursive: true}); }
  catch { return utils.build.failPlugin(`rapier-jxl: the publish folder ${publish} does not exist. Fix: set build.publish in netlify.toml to the folder your build writes.`); }
  const paths = [], taken = new Set(), started = performance.now();
  let bytesIn = 0, bytesOut = 0, left = 0;
  for (const name of names.filter(n => IMAGE.test(n)).sort()) {
    const file = join(publish, name), to = jxlName(file);
    // hero.jpg and hero.png would both be hero.jxl: the first keeps it.
    if (taken.has(to)) { left++; continue; }
    taken.add(to);
    const path = '/' + name.split(sep).map(encodeURIComponent).join('/');
    // A .jxl already beside it (the site's own, or this plug-in's on a build that kept its folder) is served, never replaced.
    if (await access(to).then(() => true, () => false)) { paths.push(path); continue; }
    try {
      const {bytes} = await toJxl(file);
      await writeFile(to, bytes);
      bytesIn += (await stat(file)).size; bytesOut += bytes.length;
      paths.push(path);
    } catch (error) {
      left++;
      console.log(`rapier-jxl left ${name} as it is: ${error.code || ''} ${error.message}`);
    }
  }
  const edgeDir = constants.INTERNAL_EDGE_FUNCTIONS_SRC;
  await mkdir(edgeDir, {recursive: true});
  const template = await readFile(new URL('./edge.mjs', import.meta.url), 'utf8');
  await writeFile(join(edgeDir, EDGE), template.replace('/* paths */[]', JSON.stringify(paths)));
  if (utils?.cache) await utils.cache.save(cacheDir);
  const summary = `${paths.length} pictures have a JPEG XL copy, ${bytesIn} bytes to ${bytesOut} (${Math.round(performance.now() - started)} ms)${left ? `; ${left} left as they are` : ''}`;
  console.log('rapier-jxl: ' + summary);
  utils?.status?.show({title: 'rapier-jxl', summary});
};
