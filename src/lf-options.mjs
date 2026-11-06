// SPDX-License-Identifier: MIT

const BROAD = {samples: 65536, bins: 128, leaves: 64, depth: 12, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3]),
  predictors: Object.freeze([5, 3, 6, 1, 2, 4, 13, 0]), weighted: true, references: true, referenceKinds: [0, 1, 2, 3], ans: true};
export const RUNGS = {broad: BROAD, jpegBroad: {...BROAD, clustered: true}, fast: {...BROAD, samples: 16384, bins: 64},
  rich: {...BROAD, samples: 4096, bins: 32, leaves: 32, depth: 8}, quick: {...BROAD, samples: 2048, bins: 16, leaves: 16, depth: 6}};
