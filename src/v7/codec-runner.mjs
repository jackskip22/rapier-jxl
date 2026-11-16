// SPDX-License-Identifier: MIT
const runners = new Map();
export const runner = (name, load) => { if (!runners.has(name)) { const loading = load(); runners.set(name, loading); loading.catch(() => runners.delete(name)); } return runners.get(name); };
export const helpers = () => import('./helpers.mjs');
export const helperFile = (role, url) => Object.freeze({role, url, worker: () => new Worker(url(), {type: 'module', name: role})});
