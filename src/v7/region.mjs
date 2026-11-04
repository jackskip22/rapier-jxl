import {fail} from './primitives.mjs';

const SIDES = ['x', 'y', 'width', 'height'];
const refuse = () => fail('JXL_OPTIONS', 'region is {x, y, width, height} in whole pixels, inside the picture.');
export function admitRegion(region) {
  if (!region || typeof region !== 'object' || Array.isArray(region) || Object.keys(region).some(key => !SIDES.includes(key))) throw refuse();
  const own = {};
  for (const key of SIDES) { const value = region[key]; if (!Number.isSafeInteger(value) || value < (key === 'x' || key === 'y' ? 0 : 1)) throw refuse(); own[key] = value; }
  return own;
}
