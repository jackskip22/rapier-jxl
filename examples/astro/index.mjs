// An Astro integration: format="jxl" on <Image> and <Picture>, written by rapier-jxl.
//   astro.config.mjs: import jxl from './src/jxl/index.mjs'; integrations: [jxl()]   or jxl({effort: 3, quality: 72, jpeg: 'exact'})
//   <Image src={photo} format="jxl" />   <Picture src={photo} formats={['jxl']} fallbackFormat="webp" />
// On @astrojs/cloudflare (imageService: 'custom'), on-demand images run service-workers.mjs inside the Worker.
import {fileURLToPath} from 'node:url';

const here = name => fileURLToPath(new URL(name, import.meta.url));

export default function jxl(options = {}) {
  return {
    name: 'rapier-jxl',
    hooks: {
      'astro:config:setup'({config, updateConfig}) {
        const own = config.image.service;
        const base = 'runtime' in own ? own.build : own;
        const conf = {...base.config, jxl: options};
        const build = {entrypoint: here('./service.mjs'), config: conf};
        const workers = config.adapter?.name === '@astrojs/cloudflare';
        updateConfig({image: {service: workers ? {build, runtime: {entrypoint: here('./service-workers.mjs'), config: conf}} : build}});
      },
    },
  };
}
