// SPDX-License-Identifier: MIT
// Generated from measured node-peak rows; never edit by hand.
// A Node server job's peak memory over a bare node (VmHWM), one straight encode at quality 90 in a fresh process, at
// each measured size: [pixels, bytes] per effort; VERIFY: what verifying that file added; BARE: a bare node, which an
// estimate includes, so it compares with the host's whole memory.
const PEAKS = {"1":[[1000230,74964992],[12192768,229183488]],"3":[[1000230,74117120],[12192768,232955904]],"5":[[1000230,73773056],[12192768,231305216]],"7":[[1000230,428580864],[12192768,2637901824]],"8":[[1000230,619859968],[12192768,4838084608]],"9":[[1000230,958246912]]};
const VERIFY = [[1000230,57556992],[12192768,343670784]];
const BARE = 43610112;

// Linear through the measured sizes and past the last two; never under the smallest measured row.
function along(points, pixels) {
  if (!points?.length) return null;
  if (points.length === 1) return points[0][1] * Math.max(1, pixels / points[0][0]);
  let i = 1;
  while (i < points.length - 1 && points[i][0] < pixels) i++;
  const [[p0, b0], [p1, b1]] = [points[i - 1], points[i]];
  return Math.max(points[0][1], b0 + (b1 - b0) * (pixels - p0) / (p1 - p0));
}
// A job's whole peak: bare node, its encode and its verification. An unmeasured effort reads the next measured effort
// above it (efforts 2, 4 and 6 the next odd one's).
export function nodeEstimate(stage, pixels) {
  const effort = stage?.options?.effort ?? 7;
  let rows = null;
  for (let e = effort; e <= 9 && !rows; e++) rows = PEAKS[e] ?? null;
  const encode = along(rows, pixels), check = along(VERIFY, pixels) ?? 0;
  return encode === null ? null : Math.ceil(BARE + encode + check);
}
