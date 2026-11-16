// SPDX-License-Identifier: MIT
import {stat} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {cliError} from './cli-error.mjs';

const LOCKFILES = [['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']];
export const PACKAGE_FILES = ['package.json', ...LOCKFILES.map(([file]) => file)];

export async function lockfileManagers(cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const found = [];
    for (const [file, manager] of LOCKFILES) if (await stat(join(dir, file)).catch(() => null)) found.push(manager);
    if (found.length) return [...new Set(found)];
    if (dirname(dir) === dir) return [];
  }
}

function quoted(arg) {
  const s = String(arg);
  if (/[%\0\r\n]/.test(s)) throw cliError('JXL_SETUP', `${s} has % or a line break, which Windows' shell would run`, 'rename or move the file so its path has neither');
  return `"${s.replace(/"/g, '""')}"`;
}
export function managerSpawn(manager, args, {cwd, env = process.env, platform = process.platform, execPath = process.execPath, quiet = false}) {
  const stdio = quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit';
  const npm = manager === 'npm' && env.npm_execpath && /(?:^|[/\\])npm(?:-cli)?\.(?:c?js|mjs)$/.test(env.npm_execpath);
  if (npm) return [execPath, [env.npm_execpath, ...args], {cwd, env, stdio, shell: false}];
  if (platform === 'win32') return [[manager, ...args.map(quoted)].join(' '), [], {cwd, env, stdio, shell: true}];
  return [manager, args, {cwd, env, stdio, shell: false}];
}
