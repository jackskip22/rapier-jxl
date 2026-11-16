// SPDX-License-Identifier: MIT
import {readFile} from 'node:fs/promises';

export const NAMES = ['jpegxl', 'rapier-jxl'];
export const COMMAND = NAMES[0];

export async function ownName() {
  try {
    const {name} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    return NAMES.includes(name) ? name : 'rapier-jxl';
  } catch { return 'rapier-jxl'; }
}

export const installs = (manifest, name) => Boolean(manifest?.dependencies?.[name] || manifest?.devDependencies?.[name]);

export const importsAs = (text, name) => text.replace(/\b(from\s*|import\s*\(\s*|import\s+|require(?:\.resolve)?\s*\(\s*|module:\s*)(['"])(?:jpegxl|rapier-jxl)(?=[/'"])/g, `$1$2${name}`);
