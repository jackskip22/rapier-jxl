import {fileURLToPath} from 'node:url';

const ENTRIES = {
  '@emdash-cms/cloudflare/storage/r2': './storage-r2.mjs',
  'emdash/storage/local': './storage-local.mjs'
};

export function rapierStorage(descriptor, options = {}) {
  const entry = ENTRIES[descriptor?.entrypoint];
  if (!entry) throw Object.assign(new TypeError("storage: r2() or local()"), {code: 'JXL_OPTIONS'});
  return {entrypoint: fileURLToPath(new URL(entry, import.meta.url)), config: {...descriptor.config, rapier: options}};
}
