// SPDX-License-Identifier: MIT
export const cliError = (code, message, fix) => Object.assign(new Error(`${message}; ${fix}`), {code, fix});
export function cliArgs(args) {
  if (!Array.isArray(args)) throw cliError('JXL_OPTIONS', 'args: array of strings', 'use: string[]');
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (typeof value !== 'string') throw cliError('JXL_OPTIONS', 'arg: string', 'each: string');
    values.push(value);
  }
  return values;
}
