// SPDX-License-Identifier: MIT
import {encode, fit} from 'rapier-jxl';
import {recompress} from 'rapier-jxl/jpeg';
import {workerAdmission} from 'rapier-jxl/resumable';
import {settings, nativeImageJob} from './media-settings.mjs';

const WORKER_MEMORY_BYTES = 128 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), {code: 'JXL_OPTIONS'});
const positive = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) throw fail(`${name} is a positive number.`);
  return value;
};

// These are the deployed host's configured allowances. No account-plan guess or sandbox quota belongs here.
export function hostOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Host limits are an object.');
  if (Object.keys(value).some(key => !['cpuLimitMs', 'memoryLimitBytes'].includes(key)))
    throw fail('Host limits name cpuLimitMs and memoryLimitBytes.');
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, positive(number, key)]));
}

export function hostLimits(platform, options = {}) {
  if (!['node', 'cloudflare'].includes(platform)) throw fail('Expected the native host platform.');
  const cpuLimitMs = options.cpuLimitMs === undefined ? null : positive(options.cpuLimitMs, 'cpuLimitMs');
  const requested = options.memoryLimitBytes === undefined ? null : positive(options.memoryLimitBytes, 'memoryLimitBytes');
  if (requested !== null && !Number.isSafeInteger(requested)) throw fail('memoryLimitBytes is a whole byte count.');
  if (platform === 'cloudflare' && requested > WORKER_MEMORY_BYTES)
    throw fail('A Cloudflare Worker cannot reserve more than its 128 MiB isolate limit.');
  return Object.freeze({platform, cpuLimitMs,
    memoryLimitBytes: requested ?? (platform === 'cloudflare' ? WORKER_MEMORY_BYTES : null)});
}

export function requestBudget(host, scheduled = false) {
  const ordinary = scheduled ? 25000 : 5000;
  return host.cpuLimitMs === null ? ordinary : Math.max(1, Math.min(ordinary, host.cpuLimitMs * 0.8));
}

// A retained JPEG never depends on a cold restore request. Unknown Worker allowances are not proof of Paid.
export const canRetireJpeg = host => host?.platform === 'node' && host.cpuLimitMs === null ||
  ['node', 'cloudflare'].includes(host?.platform) && host.cpuLimitMs >= 30000;

// Only the explicitly recorded Workers Free allowance admits browser-verified delivery with structural checks.
// A short Node limit, an unknown Worker, or a runtime resource error is not an account-plan selection.
export const deliveryOnly = host => host?.platform === 'cloudflare' && host.cpuLimitMs === 10;

// The public resumable driver's measured table is the only Worker admission reader.
// A JPEG can require both its lossless archive and its selected delivery. Both must
// be admitted; missing rows, missing dimensions, and unknown Worker CPU allowances
// are browser work, never optimistic server admissions.
const OPERATIONS = Object.freeze({encode, fit, recompress});
const dimensions = ({width, height} = {}) => Number.isSafeInteger(width) && width > 0 &&
  Number.isSafeInteger(height) && height > 0 && Number.isSafeInteger(width * height);
function measuredWork(host, item, work) {
  if (!dimensions(item)) return false;
  for (const stage of [work, ...(work.delivery ? [work.delivery] : [])]) {
    const operation = OPERATIONS[stage.operation];
    if (!operation) return false;
    const measured = workerAdmission({operation, options: stage.options, width: item.width, height: item.height});
    if (!measured.admitted || !Number.isSafeInteger(measured.measured?.estimate) ||
        measured.measured.estimate <= 0 ||
        Math.ceil(measured.measured.estimate * 1.1) > host.memoryLimitBytes) return false;
  }
  return true;
}
export function executionFor(host, value, item = {}, {archiveOriginals = false, work} = {}) {
  const selected = settings(value), plan = work ?? nativeImageJob(selected, item.mimeType, archiveOriginals);
  const hardest = Math.max(...[plan, ...(plan.delivery ? [plan.delivery] : [])].map(
    step => step.options?.effort ?? selected.effort));
  const unitMs = hardest <= 5 ? 50 : 200;
  const reason = !['image/jpeg', 'image/png'].includes(item.mimeType) ? 'format'
    : host.platform === 'cloudflare' && host.cpuLimitMs === null ? 'cpu'
    : host.cpuLimitMs !== null && host.cpuLimitMs < unitMs ? 'cpu'
    // Workers do not decode a JPEG's pixels yet (no measured row): only its exact bytes (recompress) convert there.
    // Node reads the pixels from the picture's lossless JPEG XL with the package's decoder.
    : item.mimeType === 'image/jpeg' && plan.operation !== 'recompress' && host.platform !== 'node' ? 'format'
    : host.platform === 'cloudflare' && !measuredWork(host, item, plan) ? 'memory'
    : host.platform === 'node' && host.memoryLimitBytes !== null ? 'memory' : null;
  return {location: reason ? 'browser' : 'server', reason, settings: selected,
    ...(deliveryOnly(host) && {deliveryOnly: true})};
}

// Error 1102 describes both CPU and memory failures. It cannot identify a plan or select either recovery.
export function resourceFailure(error) {
  if (['JXL_CPU_LIMIT', 'CPU_TIME_LIMIT_EXCEEDED'].includes(error?.code) || /\bCPU time limit exceeded\b/i.test(error?.message ?? '')) return 'cpu';
  if (['JXL_MEMORY', 'MEMORY_LIMIT_EXCEEDED'].includes(error?.code)) return 'memory';
  return null;
}
