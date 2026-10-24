// SPDX-License-Identifier: MIT
// encodeAsync on a GPU against encode on the CPU (gpu-encode-<gpu>.json: one row per photo and quality, both files' bytes
// compared). `gpuEncode(results)` gives the README's and the comparison page's values and refuses any row whose files
// differ: the GPU never changes a file.
const median = values => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const seconds = ms => (ms / 1000).toFixed(1);

export function gpuEncode(results) {
  if (!results.length) throw new Error('no GPU encode results (bench/gpu-encode-*.json)');
  for (const result of results) for (const row of result.rows)
    if (row.same !== true) throw new Error(`${result.gpu}: ${row.photo} q${row.quality}: the GPU file differs from the CPU file`);
  const first = results.find(result => result.gpu === 'NVIDIA T4') || results[0], lead = first.rows.filter(row => row.quality === 75);
  const table = ['| Photo | Pixels | GPU | Quality | `encode` (CPU) | `encodeAsync` (GPU) | Same file |', '| --- | ---: | --- | ---: | ---: | ---: | :---: |'];
  for (const result of results) for (const row of result.rows)
    table.push(`| ${row.photo} | ${row.width}×${row.height} | ${result.gpu} | ${row.quality} | ${seconds(row.encodeMs)} s | ${seconds(row.encodeAsyncMs)} s | yes |`);
  const summary = ['| GPU | Quality | Photos | `encode` (CPU), median | `encodeAsync` (GPU), median | Faster, median (range) |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const result of results) for (const quality of [...new Set(result.rows.map(row => row.quality))].sort((a, b) => a - b)) {
    const rows = result.rows.filter(row => row.quality === quality), ratio = rows.map(row => row.encodeMs / row.encodeAsyncMs);
    summary.push(`| ${result.gpu} | ${quality} | ${rows.length} | ${seconds(median(rows.map(row => row.encodeMs)))} s | ${seconds(median(rows.map(row => row.encodeAsyncMs)))} s | ${median(ratio).toFixed(1)}× (${Math.min(...ratio).toFixed(1)}–${Math.max(...ratio).toFixed(1)}×) |`);
  }
  const method = results.map(result => `- ${result.gpu}: ${result.browser}; CPU ${result.cpu}. ${result.photos}. ${result.method}`).join('\n');
  return {GPU_PHOTO_S: seconds(median(lead.map(row => row.encodeAsyncMs))), CPU_PHOTO_S: seconds(median(lead.map(row => row.encodeMs))),
    GPU_PHOTOS: String(lead.length), GPU_NAME: first.gpu, GPU_SUMMARY: summary.join('\n'), GPU_TABLE: table.join('\n'), GPU_METHOD: method};
}
