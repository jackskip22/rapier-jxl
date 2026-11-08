// One settings record for the admin, browser worker and native upload hook.
export const DEFAULTS = {quality: 90, exact: false, effort: 3, maxKilobytes: 0,
  widths: [640, 750, 828, 960, 1080, 1280, 1668, 1920, 2048, 2560, 3200, 3840]};

export function settings(value) {
  const v = {...DEFAULTS, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {})};
  const quality = Number(v.quality), effort = Number(v.effort), limit = Number(v.maxKilobytes);
  const widths = Array.isArray(v.widths) ? [...new Set(v.widths.map(Number))]
    .filter(w => Number.isSafeInteger(w) && w >= 16 && w <= 8192).sort((a, b) => a - b).slice(0, 16) : [...DEFAULTS.widths];
  const exact = v.exact === true;
  return {quality: Number.isFinite(quality) ? Math.min(100, Math.max(1, Math.round(quality))) : DEFAULTS.quality,
    exact, effort: Number.isInteger(effort) && effort >= 1 && effort <= 9 ? effort : DEFAULTS.effort,
    maxKilobytes: exact ? 0 : Number.isFinite(limit) ? Math.max(0, Math.min(1 << 20, Math.round(limit))) : 0, widths};
}

// Goals select the package's existing verbs; there is no plug-in quality scale or encoder.
export function imageJob(value, jpeg = false) {
  const {quality, exact, effort, maxKilobytes} = settings(value);
  // A JPEG's reversible archive is independent of its selected delivery. Exact delivery can reuse that archive.
  if (jpeg && (exact || quality === 100 && maxKilobytes === 0)) return {operation: 'recompress', options: {effort}};
  if (maxKilobytes > 0) return {operation: 'fit', options: {maxBytes: maxKilobytes * 1024,
    fidelity: {quality: {min: 1, max: 100}}, effort}};
  return {operation: 'encode', options: {fidelity: exact ? 'exact' : {quality}, effort}};
}

// The single native work plan is shared by Worker admission and the runner.
// Archival is a separate reversible JPEG step; it must also fit the host.
export function nativeImageJob(value, mimeType, archiveOriginals = true) {
  const site = settings(value), delivery = imageJob(site, mimeType === 'image/jpeg');
  const archiveFirst = mimeType === 'image/jpeg' && archiveOriginals && delivery.operation !== 'recompress';
  return {...(archiveFirst ? {operation: 'recompress', options: {effort: site.effort}, delivery} : delivery),
    settings: site, ...(site.maxKilobytes && {maxBytes: site.maxKilobytes * 1024})};
}
