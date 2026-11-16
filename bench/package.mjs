// The installed package under either of its names, and libjxl's tools (JXL_DJXL, JXL_SSIMULACRA2) for the look.
import {existsSync, readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

export function packageDir(modules) {
  const dir = ['jpegxl', 'rapier-jxl'].map(name => join(modules, name)).find(path => existsSync(join(path, 'package.json')));
  if (!dir) throw new Error(`No jpegxl package in ${modules}`);
  return dir;
}
// One public entry as Node loads it: `entry(modules, 'jpeg')` is what `import 'jpegxl/jpeg'` gives in Node.
export function entry(modules, name) {
  const dir = packageDir(modules), value = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).exports[name === '.' ? '.' : `./${name}`];
  const file = typeof value === 'string' ? value : value.node ?? value.import ?? value.default;
  return import(pathToFileURL(join(dir, typeof file === 'string' ? file : file.import ?? file.default)).href);
}
// SSIMULACRA 2 of a PNG against a reference PNG; a .jxl is decoded by libjxl's djxl first.
export function score(reference, file, scratch) {
  const tool = name => process.env[name] ?? (() => { throw new Error(`Set ${name} to libjxl's tool`); })();
  if (file.endsWith('.jxl')) { execFileSync(tool('JXL_DJXL'), [file, join(scratch, 'decoded.png')], {stdio: 'ignore'}); file = join(scratch, 'decoded.png'); }
  return Number(execFileSync(tool('JXL_SSIMULACRA2'), [reference, file], {encoding: 'utf8'}).trim().split(/\s+/).pop());
}
