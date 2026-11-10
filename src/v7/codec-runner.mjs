// SPDX-License-Identifier: MIT
const runners = new Map();
export const runner = (name, load) => { if (!runners.has(name)) { const loading = load(); runners.set(name, loading); loading.catch(() => runners.delete(name)); } return runners.get(name); };
export const helpers = () => import('./helpers.mjs');
export const helperFile = (url, worker) => Object.freeze({url, worker});
