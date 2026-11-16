// SPDX-License-Identifier: MIT
export const cliError = (code, message, fix) => Object.assign(new Error(`${message}; ${fix}.`), {code, fix});
export function cliArgs(args) {
  if (!Array.isArray(args)) throw cliError('JXL_OPTIONS', 'Command arguments are not an array of text values', 'pass an array of strings');
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (typeof value !== 'string') throw cliError('JXL_OPTIONS', 'A command argument is not text', 'pass each argument as a string');
    values.push(value);
  }
  return values;
}
