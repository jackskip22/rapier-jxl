// SPDX-License-Identifier: MIT
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const compiler=process.env.CXX||'g++',flags=['-std=c++17','-O2','-Wall','-Wextra'];
const positional=[],option={};
for(let i=2;i<process.argv.length;i++)process.argv[i]==='--out'?option.out=process.argv[++i]:positional.push(process.argv[i]);
const headers=positional[0]?resolve(positional[0]):null;
const library=positional[1]?resolve(positional[1]):null;
// The binary and its receipt go beside each other, outside the repository by default when --out is given.
const out=resolve(option.out||here);
const source=join(here,'libjxl.cc'),binary=join(out,'libjxl');
const args=[...flags,...(headers?['-I',headers]:[]),source,library||'-ljxl','-o',binary];
const built=spawnSync(compiler,args,{stdio:'inherit'});if(built.error)throw built.error;if(built.status!==0)process.exit(built.status||1);
const version=spawnSync(compiler,['--version'],{encoding:'utf8'});if(version.error||version.status!==0)throw version.error||new Error('Compiler metadata failed');
const linked=spawnSync('ldd',[binary],{encoding:'utf8'});if(linked.error||linked.status!==0)throw linked.error||new Error('Linked-library metadata failed');
const linkedLibrary=linked.stdout.match(/^\s*libjxl\.so[^\s]*\s+=>\s+(\S+)/m)?.[1];
if(!linkedLibrary)throw new Error('Cannot identify the linked libjxl library');
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const receipt={compiler:version.stdout.split('\n')[0],flags,headers,library:linkedLibrary,librarySha256:sha(linkedLibrary),binarySha256:sha(binary),sourceSha256:sha(source),command:[compiler,...args]};
writeFileSync(join(out,'libjxl-build.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
