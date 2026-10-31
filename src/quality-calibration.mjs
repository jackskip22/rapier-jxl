// SPDX-License-Identifier: MIT
const QUALITY = [30, 50, 70, 90, 95];
const CALIBRATION_ROWS = {
  fast: [0.659, 0.652, 0.609, 0.497, 0.453],
  full: [0.692, 0.685, 0.644, 0.513, 0.465],
  blocks: [0.673, 0.675, 0.644, 0.513, 0.465],
  blocksFast: [0.6748, 0.6732, 0.6414, 0.5120, 0.4643],
  ycbcr: [0.675, 0.686, 0.685, 0.651, 0.658],
  screen: [0.362, 0.391, 0.393, 0.328, 0.342],
  screenFull: [0.365, 0.420, 0.441, 0.338, 0.351],
  s2e8: [0.7268, 0.7481, 0.6893, 0.5197, 0.4627],
  s2e9: [0.7268, 0.7426, 0.6891, 0.5171, 0.4697],
};
export function calibration(quality, row) {
  const factor = CALIBRATION_ROWS[row === true ? 'fast' : row === false ? 'full' : row];
  if (quality <= QUALITY[0]) return factor[0];
  for (let i = 1; i < QUALITY.length; i++)
    if (quality <= QUALITY[i]) return factor[i - 1] + (factor[i] - factor[i - 1]) * (quality - QUALITY[i - 1]) / (QUALITY[i] - QUALITY[i - 1]);
  return factor[QUALITY.length - 1];
}
