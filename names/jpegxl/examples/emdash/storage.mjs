import {fileURLToPath} from 'node:url';

const ENTRIES = {
  '@emdash-cms/cloudflare/storage/r2': './storage-r2.mjs',
  'emdash/storage/local': './storage-local.mjs'
};

export function rapierStorage(descriptor, options = {}) {
  const entry = ENTRIES[descriptor?.entrypoint];
  if (!entry) throw new TypeError('rapier-jxl/emdash takes EmDash storage from r2() or local()');
  return {entrypoint: fileURLToPath(new URL(entry, import.meta.url)), config: {...descriptor.config, rapier: options}};
}
