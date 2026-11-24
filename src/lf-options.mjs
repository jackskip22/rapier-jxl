// SPDX-License-Identifier: MIT

const BROAD = {samples: 65536, bins: 128, leaves: 64, depth: 12, properties: Object.freeze([15, 9, 10, 11, 12, 13, 14, 4, 5, 6, 7, 8, 2, 3]),
  predictors: Object.freeze([5, 3, 6, 1, 2, 4, 13, 0]), weighted: true, references: true, referenceKinds: [0, 1, 2, 3], ans: true};
const ALL_PREDICTORS = Object.freeze([5, 3, 6, 1, 2, 4, 13, 0, 7, 8, 9, 10, 11, 12]);
const ALL_LF = {predictors: ALL_PREDICTORS, crossAns: true};
const JPEG_LF = (typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) ? {predictors: ALL_PREDICTORS, subsampledReferences: true, crossAns: true} : null;
const TEN = (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) ? {...BROAD, samples: 262144, bins: 255, leaves: 128, depth: 14, charge: 4, ansExtra: true} : null;
export const RUNGS = {...(typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && {ten: TEN,
    ...(typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) && {jpegTen: {...TEN, ...JPEG_LF}}},
  ...(!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && {
    fastCross: {...BROAD, samples: 16384, bins: 64, crossAns: true},
    broadCross: {...BROAD, crossAns: true},
    broadFine: {...BROAD, samples: 262144, bins: 255, leaves: 128, depth: 14, least: 32, charge: 4, crossAns: true}}),
  broad: BROAD,
  jpegBroad: {...BROAD, clustered: true},
  ...((typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) && {
    jpegAll: {...BROAD, ...JPEG_LF},
    jpegFine: {...BROAD, ...JPEG_LF, leaves: 128, least: 24, charge: 2},
    jpegFast: {...BROAD, ...JPEG_LF, samples: 16384, bins: 64},
    jpegRich: {...BROAD, ...JPEG_LF, samples: 4096, bins: 32, leaves: 32, depth: 8}}),
  fast: {...BROAD, samples: 16384, bins: 64},
  rich: {...BROAD, samples: 4096, bins: 32, leaves: 32, depth: 8},
  broadAll: {...BROAD, ...ALL_LF},
  fastAll: {...BROAD, ...ALL_LF, samples: 16384, bins: 64},
  richAll: {...BROAD, ...ALL_LF, samples: 4096, bins: 32, leaves: 32, depth: 8},
  quick: {...BROAD, samples: 2048, bins: 16, leaves: 16, depth: 6}};
