// rapier-jxl/emdash: JPEG XL for an EmDash site, in its astro.config:
//   integrations: [react(), jxl(emdash, {database: d1({binding: 'DB'}), storage: r2({binding: 'MEDIA'})})]
// Wraps EmDash's r2() or local() storage, adds the JPEG XL plug-in and the delivery middleware.
import {fileURLToPath} from 'node:url';
import {rapierStorage} from './storage.mjs';
import {WORDS} from './media-words.mjs';
import {hostOptions} from './host-policy.mjs';

// The same id, version and pages as createPlugin() in media-plugin.mjs.
const ID = 'rapier-media', VERSION = '0.1.0', PAGES = [{path: '/jpeg-xl', label: WORDS.name, icon: 'image'}];
const file = name => new URL(name, import.meta.url), path = name => fileURLToPath(file(name));

function rapierMediaPlugin() {
  return {id: ID, version: VERSION, format: 'native', entrypoint: path('./media-plugin.mjs'),
    adminEntry: path('./media-admin.mjs'), adminPages: PAGES};
}

export function jxl(emdash, config = {}, limits = {}) {
  if (typeof emdash !== 'function') throw new TypeError("Pass EmDash's integration first: jxl(emdash, {database, storage})");
  if (!config.storage) throw new TypeError('Name the storage: jxl(emdash, {storage: r2({binding}) or local({directory})})');
  return [emdash({...config, storage: rapierStorage(config.storage, hostOptions(limits)), plugins: [...(config.plugins ?? []), rapierMediaPlugin()]}),
    {name: 'rapier-jxl', hooks: {'astro:config:setup': ({addMiddleware}) => addMiddleware({entrypoint: file('./middleware.mjs'), order: 'pre'})}}];
}
