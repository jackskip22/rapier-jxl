// SPDX-License-Identifier: MIT
export const entryKey = name => typeof name === 'string' ? name.replace(/^jpegxl(?=\/|$)/, 'rapier-jxl') : name;
export const shownEntry = name => name.replace(/^rapier-jxl(?=\/|$)/, 'jpegxl');
