// SPDX-License-Identifier: MIT
import {readFile, mkdir, rm, readdir, cp, mkdtemp, rmdir, stat, lstat, realpath, access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep, delimiter} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {atomicWrite, insideProject, readManifest, readIfAny, refuseReadOnly, refuseLinks} from './project-files.mjs';
import {writeProjectEdits, removeProjectEdits} from './project-edits.mjs';
import {COMMAND} from './package-name.mjs';
import {cliError as fail, cliArgs} from './cli-error.mjs';

const RECORD = '.rapier-jxl-add.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function matchesDigest(bytes, digest) {
  if (sha(bytes) === digest) return true;
  if (bytes.includes(0)) return false;
  return sha(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')) === digest;
}
const read = path => readIfAny(path);
const present = async path => (await stat(path).catch(() => null)) !== null;
const posix = path => path.split(sep).join('/');
const setup = (message, fix) => fail('JXL_SETUP', message, fix);

async function examples(place = 'android') {
  for (const url of [new URL('../examples/', import.meta.url), new URL('./examples/', import.meta.url)])
    if (await present(join(fileURLToPath(url), place))) return fileURLToPath(url);
  throw setup('package: incomplete', `reinstall: ${COMMAND}`);
}

const WORDPRESS_HELP = `Usage: ${COMMAND} add wordpress [--path <dir>] [--dry-run] [--json]
       ${COMMAND} remove wordpress [--path <dir>] [--dry-run] [--json]

Run in the WordPress folder with wp-config.php, or name it with --path.
Copy the packaged plug-in to wp-content/plugins/jpegxl. A rerun refuses files you edited after installation.
remove restores the original files and permissions. Local extras stay as they are.
--dry-run lists the copies without writing. Activate "JPEG XL Images" in Plugins afterward.`;

async function wordpressCli(cwd) {
  const windows = process.platform === 'win32';
  const suffixes = windows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of process.env.PATH?.split(delimiter) ?? []) for (const suffix of suffixes) {
    const path = resolve(cwd, dir.replace(/^"(.*)"$/, '$1'), 'wp' + suffix);
    try {
      if ((await stat(path)).isFile()) {
        await access(path, windows ? constants.F_OK : constants.X_OK);
        return true;
      }
    } catch {}
  }
  return false;
}

function wordpressFlags(verb, args) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {help: true};
  let path, dryRun = false, json = false;
  const fix = `run: npx ${COMMAND} ${verb} wordpress --help`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if (arg === '--path' && path === undefined) {
      path = args[++i];
      if (!path || path.startsWith('-') || path.includes('\0')) throw fail('JXL_OPTIONS', '--path: folder required', fix);
    } else throw fail('JXL_OPTIONS', `${verb} wordpress: unknown or repeated option ${arg}`, fix);
  }
  return {path, dryRun, json};
}

async function wordpressFiles() {
  const source = join(await examples('wordpress'), 'wordpress'), files = new Map();
  const collect = async (dir, prefix = '') => {
    const entries = (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = prefix + entry.name, from = join(dir, entry.name);
      if (entry.isDirectory()) await collect(from, name + '/');
      else if (entry.isFile()) files.set('wp-content/plugins/jpegxl/' + name, await readFile(from));
      else throw setup(`WordPress package: unsupported file ${name}`, `reinstall: ${COMMAND}`);
    }
  };
  await collect(source);
  if (!files.has('wp-content/plugins/jpegxl/rapier-jxl.php')) throw setup('WordPress package: rapier-jxl.php missing', `reinstall: ${COMMAND}`);
  return files;
}

export async function runAddWordpress(args, {cwd, version, stdout}) {
  const given = wordpressFlags('add', args);
  if (given.help) { stdout(WORDPRESS_HELP); return; }
  const {path, dryRun, json} = given, folder = resolve(cwd, path ?? '.');
  let config;
  try { config = await stat(join(folder, 'wp-config.php')); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  if (!config?.isFile()) throw setup('WordPress folder: need wp-config.php', `run: npx ${COMMAND} add wordpress --path <WordPress folder>`);
  const root = await realpath(folder), files = await wordpressFiles();
  await refuseLinks(root, ['wp-config.php'], setup);
  const targets = new Map([['.', true]]), existing = new Set();
  for (const name of files.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) targets.set(parts.slice(0, i).join('/'), true);
    targets.set(name, false);
  }
  for (const [name, directory] of targets) {
    const to = join(root, name);
    let info;
    try { info = await lstat(to); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!info) continue;
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))
      throw setup(`${name}: need a plain ${directory ? 'folder' : 'file'}`, 'replace the link or conflicting path, then run add again');
    if (!directory) await refuseReadOnly(to, name);
    existing.add(name);
  }
  const writable = new Set();
  for (const [name, directory] of targets) if (name !== '.' && (!directory || !existing.has(name))) writable.add(dirname(name));
  for (const name of writable) if (existing.has(name)) await refuseReadOnly(join(root, name), name);
  const names = [...files.keys()];
  await insideProject(root, names, setup);
  const changes = names.map(file => ({file, action: existing.has(file) ? 'updated' : 'created'}));
  const next = [`Activate "JPEG XL Images" in Plugins${await wordpressCli(cwd) ? ' or run wp plugin activate jpegxl from the WordPress folder' : ''}.`];
  await writeProjectEdits(root, 'wordpress', version, files, {dryRun, allowedFiles: names});
  if (json) { stdout(JSON.stringify({type: 'add', place: 'wordpress', dryRun, changes, next})); return; }
  if (dryRun) for (const file of names) stdout(`would copy examples/wordpress/${file.slice('wp-content/plugins/jpegxl/'.length)} -> ${file}`);
  else stdout(next[0]);
}

export async function runRemoveWordpress(args, {cwd, stdout}) {
  const given = wordpressFlags('remove', args);
  if (given.help) { stdout(WORDPRESS_HELP); return; }
  const {path, dryRun, json} = given, root = await realpath(resolve(cwd, path ?? '.'));
  const files = await wordpressFiles();
  await removeProjectEdits('wordpress', [...dryRun ? ['--dry-run'] : [], ...json ? ['--json'] : []],
    {cwd: root, stdout, allowedFiles: [...files.keys()]});
}

const SOURCES = {
  android: {example: 'android', parts: ['app/src/main/assets/encoder.html', 'app/src/main/assets/encoder.mjs', 'prepare-assets.mjs']},
  ios: {example: 'ios', parts: ['Package.swift', 'Sources', 'prepare-assets.mjs'], make: ['ios/Tests/RapierJXLTests/Fixtures']},
  flutter: {example: 'flutter', parts: ['pubspec.yaml', 'lib', 'assets', 'prepare-assets.mjs'], make: ['flutter/example/assets/fixtures']},
  expo: {example: 'react-native', parts: ['src', 'web', 'prepare-assets.mjs']},
  capacitor: {example: 'capacitor', parts: ['save.mjs', 'prepare-assets.mjs']},
  electron: {example: 'electron', parts: ['main.mjs', 'preload.cjs', 'prepare-assets.mjs'], desktop: true},
  tauri: {example: 'tauri', parts: ['prepare-assets.mjs'], desktop: true}
};

async function packageFolder(given) {
  const dir = given ?? fileURLToPath(new URL('../', import.meta.url));
  if (!await present(join(dir, 'dist', 'upload.mjs'))) throw setup('browser files: dist/upload.mjs missing', `reinstall: ${COMMAND}`);
  return dir;
}

async function prepared(place, root, packageDir) {
  const source = SOURCES[place], scratch = await mkdtemp(join(tmpdir(), 'jxl-add-'));
  try {
    const stage = join(scratch, source.example);
    for (const part of source.parts) await cp(join(root, source.example, part), join(stage, part), {recursive: true,
      filter: path => !relative(join(root, source.example), path).split(sep).includes('jpegxl')});
    if (source.desktop) await cp(join(root, 'desktop'), join(scratch, 'desktop'), {recursive: true});
    for (const dir of source.make ?? []) await mkdir(join(scratch, dir), {recursive: true});
    const url = pathToFileURL(join(scratch, source.example, 'prepare-assets.mjs')).href;
    if (source.desktop) {
      const {prepare} = await import(pathToFileURL(join(scratch, 'desktop/prepare.mjs')).href);
      await prepare({app: stage, web: join(stage, 'web'), packageDir});
    } else await (await import(url)).prepareAssets({example: stage, packageDir});
    const files = new Map();
    const walk = async dir => { for (const entry of await readdir(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      const name = posix(relative(stage, path));
      if (!/^(prepare-assets\.mjs|web-assets\.json|build\/|example\/|Tests\/)/.test(name + (entry.isDirectory() ? '/' : ''))) {
        if (entry.isDirectory()) await walk(path); else files.set(name, await readFile(path));
      }
    } };
    await walk(stage);
    return files;
  } catch (error) {
    throw error?.code === 'JXL_PACKAGE' ? setup(error.message, `reinstall: ${COMMAND}`) : error;
  } finally { await rm(scratch, {recursive: true, force: true}); }
}

function dropTestTarget(text) {
  const start = text.search(/^[ \t]*\.testTarget\(/m);
  if (start < 0) return text;
  let depth = 0, i = text.indexOf('(', start);
  for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; }
  return text.slice(0, start) + text.slice(text.indexOf('\n', i) + 1 || text.length);
}

function pubspecAdd(text) {
  if (/^[ \t]+rapier_jxl\s*:/m.test(text)) return {text, lines: null};
  const match = text.match(/^dependencies:[ \t]*(?:#[^\r\n]*)?\r?\n/m);
  if (!match) return null;
  const nl = match[0].endsWith('\r\n') ? '\r\n' : '\n', at = match.index + match[0].length;
  const indent = text.slice(at).match(/^([ \t]+)\S/)?.[1] ?? '  ', lines = [`${indent}rapier_jxl:`, `${indent}  path: packages/rapier_jxl`];
  return {text: text.slice(0, at) + lines.join(nl) + nl + text.slice(at), lines};
}
const pubspecRemove = (text, lines) => {
  const block = lines.join(text.includes('\r\n') ? '\r\n' : '\n') + (text.includes('\r\n') ? '\r\n' : '\n');
  return text.includes(block) ? text.replace(block, '') : null;
};

const kind = {android: 'an Android', ios: 'an iOS', flutter: 'a Flutter', expo: 'a React Native or Expo', capacitor: 'a Capacitor', electron: 'an Electron', tauri: 'a Tauri'};
const dependsOn = async (cwd, names) => {
  const manifest = (await readManifest(cwd, setup))?.manifest, deps = {...manifest?.dependencies, ...manifest?.devDependencies};
  return names.some(name => deps[name]);
};

const PLACES = {
  android: {
    line: 'An Android app: the WebView bridge and the encoder in its assets, no native code.',
    looked: 'app/src/main/AndroidManifest.xml (or src/main/AndroidManifest.xml beside a build.gradle)',
    async find(cwd) {
      for (const module of ['app', '']) {
        const manifest = (await read(join(cwd, module, 'src/main/AndroidManifest.xml')))?.toString();
        if (manifest === undefined || manifest === null) continue;
        const rawGradle = (await Promise.all(['build.gradle.kts', 'build.gradle'].map(n => read(join(cwd, module, n))))).find(Boolean)?.toString() ?? '';
        const gradle = rawGradle.replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\r\n]*/gm, '');
        const cleanXml = manifest.replace(/<!--[\s\S]*?-->/g, '');
        const namespace = gradle.match(/\bnamespace\s*=?\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)["']/)?.[1] ?? cleanXml.match(/<manifest[^>]*\bpackage="([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)"/)?.[1];
        if (!namespace) throw setup('Android namespace: missing', `add: namespace = "com.example.app" in ${posix(join(module, 'build.gradle.kts'))}`);
        return {module, namespace};
      }
      return null;
    },
    anchor: ({module, namespace}) => join(module, 'src/main/java', ...namespace.split('.'), 'rapierjxl'),
    async files({module, namespace}, made, root) {
      const base = join(module, 'src/main'), out = new Map(), generated = 'app/build/generated/encoder-assets/';
      for (const name of ['encoder.html', 'encoder.mjs']) out.set(posix(join(base, 'assets', name)), made.get('app/src/main/assets/' + name));
      for (const [path, bytes] of made) if (path.startsWith(generated)) out.set(posix(join(base, 'assets', path.slice(generated.length))), bytes);
      for (const name of ['BridgeProtocol.kt', 'MainActivity.kt']) {
        const text = await readFile(join(root, 'android/app/src/main/java/app/rapier/jxlexample', name), 'utf8');
        const ktKeywords = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while']);
        const ktNs = namespace.split('.').map(seg => ktKeywords.has(seg) ? `\`${seg}\`` : seg).join('.');
        out.set(posix(join(base, 'java', ...namespace.split('.'), 'rapierjxl', name)), Buffer.from(text.replace(/^package app\.rapier\.jxlexample$/m, `package ${ktNs}.rapierjxl`)));
      }
      return out;
    },
    async next({module, namespace}, root) {
      const dependency = (await readFile(join(root, 'android/app/build.gradle.kts'), 'utf8')).match(/implementation\("androidx\.webkit:webkit:[\d.]+"\)/)[0];
      return [`add ${dependency} to dependencies in ${posix(join(module, 'build.gradle.kts'))} (or build.gradle)`,
        `add <activity android:name=".rapierjxl.MainActivity" android:exported="false"/> inside <application> in ${posix(join(module, 'src/main/AndroidManifest.xml'))}`,
        `startActivity(Intent(this, ${namespace}.rapierjxl.MainActivity::class.java)) opens the example screen; its code is the bridge to copy from`];
    }
  },
  ios: {
    line: 'An iOS or macOS app: a Swift package (RapierJXL) that runs the encoder in a WKWebView, no native code.',
    looked: 'an .xcodeproj, .xcworkspace, project.yml or Package.swift',
    find: async cwd => (await readdir(cwd)).some(n => /\.(xcodeproj|xcworkspace)$/.test(n) || n === 'project.yml' || n === 'Package.swift') ? {} : null,
    anchor: () => 'RapierJXL',
    async files(_, made) {
      const out = new Map();
      for (const [path, bytes] of made) out.set('RapierJXL/' + path, path === 'Package.swift' ? Buffer.from(dropTestTarget(bytes.toString())) : bytes);
      return out;
    },
    next: () => ['in Xcode: File, Add Package Dependencies, Add Local, choose the RapierJXL folder; then import RapierJXL and call try await JXLCodec().encode(photo)']
  },
  flutter: {
    line: 'A Flutter app: a Dart package (rapier_jxl) that runs the encoder in a web view, no native code.',
    looked: 'a pubspec.yaml that depends on the flutter sdk',
    find: async cwd => /^[ \t]+sdk:[ \t]*['"]?flutter['"]?[ \t]*(?:#.*)?$/m.test((await read(join(cwd, 'pubspec.yaml')))?.toString() ?? '') ? {} : null,
    anchor: () => 'packages/rapier_jxl',
    async files(_, made) {
      const out = new Map();
      for (const [path, bytes] of made) if (!path.endsWith('.keep')) out.set('packages/rapier_jxl/' + path, bytes);
      return out;
    },
    config: 'pubspec.yaml',
    next: () => ['the web view serves its page on 127.0.0.1: Android needs android.permission.INTERNET and a network security config that allows cleartext to 127.0.0.1 only; iOS needs NSAppTransportSecurity with NSAllowsLocalNetworking; macOS needs the com.apple.security.network.server and network.client entitlements',
      "flutter pub get; then import 'package:rapier_jxl/rapier_jxl.dart'; and call await JXLCodec().encode(photoBytes)"]
  },
  expo: {
    line: 'A React Native or Expo app: JXLProvider and useJXL run the encoder in a hidden WebView, no native code.',
    looked: 'a package.json that depends on expo or react-native',
    find: async cwd => await dependsOn(cwd, ['expo', 'react-native']) ? {src: await present(join(cwd, 'src')) ? 'src/' : ''} : null,
    anchor: ({src}) => src + 'rapier-jxl',
    async files({src}, made) {
      const out = new Map();
      for (const [path, bytes] of made) if (path.startsWith('src/') && path !== 'src/selftest.ts') {
        const code = !path.startsWith('src/generated/') || path === 'src/generated/page.ts';
        out.set(`${src}rapier-jxl/${path.slice(4)}`, code ? Buffer.from(bytes.toString().replace(
          /(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)\.tsx?\2/g, '$1$2$3$2')) : bytes);
      }
      return out;
    },
    next: ({src}) => ['npx expo install react-native-webview',
      `put <JXLProvider> once, high in the tree, and call useJXL().encode(bytes): import {JXLProvider, useJXL} from './${src}rapier-jxl/index'`]
  },
  capacitor: {
    line: 'A Capacitor app: the encoder runs in web workers in its web app; Capacitor\'s Filesystem plug-in saves the file, no codec bridge.',
    looked: 'capacitor.config.json (or .ts or .js) and @capacitor/core in package.json',
    async find(cwd) {
      const config = (await Promise.all(['json', 'ts', 'js'].map(ext => read(join(cwd, `capacitor.config.${ext}`))))).find(Boolean)?.toString();
      if (config === undefined || !await dependsOn(cwd, ['@capacitor/core'])) return null;
      const webDir = config.match(/["']?webDir["']?\s*:\s*["']([^"']+)["']/)?.[1]?.replace(/^\.\//, '').replace(/\/$/, '');
      const base = await present(join(cwd, 'src')) ? 'src/' : webDir && /^(www|public)$/.test(webDir) && await present(join(cwd, webDir)) ? webDir + '/' : '';
      return {base};
    },
    anchor: ({base}) => base + 'rapier-jxl',
    async files({base}, made) {
      const out = new Map();
      for (const [path, bytes] of made) out.set(`${base}rapier-jxl/${path.replace(/^jpegxl\//, '')}`, bytes);
      return out;
    },
    async next({base}, _, cwd) {
      const manifest = (await readManifest(cwd, setup)).manifest, deps = {...manifest.dependencies, ...manifest.devDependencies};
      const coreVer = deps['@capacitor/core'];
      const major = typeof coreVer === 'string' ? coreVer.match(/\d+/)?.[0] : undefined;
      return [...deps['@capacitor/filesystem'] ? [] : [`npm install @capacitor/filesystem${major ? '@' + major : ''}`],
        `in a file beside the rapier-jxl folder: import {encode} from './rapier-jxl/upload.browser.mjs' and {saveJxl} from './rapier-jxl/save.mjs'; then saveJxl(new Blob([(await encode(photo)).bytes]), 'photo.jxl') writes the file and returns its uri`,
        'npx cap sync'];
    }
  },
  electron: {
    line: 'An Electron app: the encoder runs in the window as it is; the example main process and page are copied beside it.',
    looked: 'a package.json that depends on electron',
    find: async cwd => await dependsOn(cwd, ['electron']) ? {} : null,
    anchor: () => 'rapier-jxl',
    async files(_, made) {
      const out = new Map();
      for (const [path, bytes] of made) if (/^(main\.mjs|preload\.cjs|web\/)/.test(path)) out.set('rapier-jxl/' + path, bytes);
      return out;
    },
    next: () => ['npx electron rapier-jxl/main.mjs opens the example window; main.mjs shows the app:// handler, the policy and the cross-origin isolation headers the page needs, and preload.cjs its one Save call',
      "in your own main process, import {encode} from 'jpegxl/upload': Node needs no setup"]
  },
  tauri: {
    line: 'A Tauri 2 app: the page and encoder files for its web view; the Rust side stays yours.',
    looked: 'src-tauri/tauri.conf.json',
    find: async cwd => await present(join(cwd, 'src-tauri/tauri.conf.json')) || await present(join(cwd, 'src-tauri/tauri.conf.json5')) ? {} : null,
    anchor: () => 'rapier-jxl',
    async files(_, made) {
      const out = new Map();
      for (const [path, bytes] of made) if (path.startsWith('web/')) out.set('rapier-jxl/' + path, bytes);
      return out;
    },
    next: () => ["serve rapier-jxl/web in the web view: set build.frontendDist in src-tauri/tauri.conf.json to ../rapier-jxl/web, or copy the folder into your frontend's",
      "app.security.csp: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost blob:; img-src 'self' blob: data:; media-src blob:; base-uri 'none'",
      'app.security.headers: Cross-Origin-Opener-Policy same-origin, Cross-Origin-Embedder-Policy require-corp, Cross-Origin-Resource-Policy same-origin',
      'the page saves through one command, save: copy it from examples/tauri/src-tauri/src/main.rs in the package, and run cargo add tauri-plugin-dialog']
  }
};
export const PLACE_NAMES = Object.keys(PLACES);
export const placeLines = () => PLACE_NAMES.map(name => ({name, line: PLACES[name].line}));

const HELP = place => `Usage: ${COMMAND} add ${place} [--dry-run] [--json]
       ${COMMAND} remove ${place} [--dry-run] [--json]

${PLACES[place].line}
It looks for ${PLACES[place].looked}, copies the bridge files and the package's browser files into it,
changes a config file only where that is safe, and prints what it changed and the lines it leaves to you.
Running it again changes nothing; a file you edited is left as it is. remove deletes exactly what add wrote.`;

function flags(place, verb, args) {
  args = cliArgs(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {help: true};
  const unknown = args.find(a => a !== '--dry-run' && a !== '--json');
  if (unknown) throw fail('JXL_OPTIONS', `${verb} ${place}: unknown option ${unknown}`, `run: npx ${COMMAND} ${verb} ${place} --help`);
  return {dryRun: args.includes('--dry-run'), json: args.includes('--json')};
}

async function locate(place, cwd) {
  const found = await PLACES[place].find(cwd);
  if (!found) throw setup(`${kind[place]}: need ${PLACES[place].looked}`, `run: npx ${COMMAND} add ${place} in the project folder`);
  return found;
}
function allowedPrefixes(place, spec, found) {
  const anchor = posix(spec.anchor(found)) + '/', assets = posix(join(found.module ?? '', 'src/main/assets')) + '/';
  return place === 'android' ? {prefixes: [assets + 'jpegxl/', anchor], names: ['encoder.html', 'encoder.mjs', 'headers.json'].map(n => assets + n)} : {prefixes: [anchor], names: []};
}
const badRel = p => typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\') || isAbsolute(p) || p.split('/').some(s => !s || s === '.' || s === '..');
async function recordOf(cwd, recordPath, place, spec, found) {
  const [land] = await insideProject(cwd, [recordPath], setup);
  const raw = (await read(land))?.toString();
  if (raw === undefined || raw === null) return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw setup(`${recordPath} is not valid JSON`, `fix or delete ${recordPath}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw setup(`${recordPath} is not a setup record`, `fix or delete ${recordPath}`);
  if (parsed.place !== place)
    throw setup(`${recordPath} belongs to ${COMMAND} add ${parsed.place || 'another integration'}, not ${place}`, `run npx ${COMMAND} remove ${parsed.place || '<place>'} first`);
  if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files) || !Array.isArray(parsed.dirs))
    throw setup(`${recordPath} has invalid entries`, `fix or delete ${recordPath}`);
  const {prefixes, names} = allowedPrefixes(place, spec, found);
  for (const [p, d] of Object.entries(parsed.files)) {
    if (badRel(p) || p === recordPath ||
        !(prefixes.some(pre => p.startsWith(pre)) || names.includes(p)) || typeof d !== 'string' || !/^[0-9a-f]{64}$/.test(d))
      throw setup(`${recordPath} lists an unmanaged file (${p})`, `fix or delete ${recordPath}`);
  }
  for (const dir of parsed.dirs) {
    if (badRel(dir) ||
        !prefixes.some(pre => pre.startsWith(dir + '/') || (dir + '/').startsWith(pre)))
      throw setup(`${recordPath} lists an unmanaged folder (${dir})`, `fix or delete ${recordPath}`);
  }
  if (parsed.config !== undefined && parsed.config !== null) {
    const c = parsed.config;
    if (!spec.config || typeof c !== 'object' || Array.isArray(c) || c.file !== spec.config || !Array.isArray(c.lines) ||
        c.lines.length !== 2 || !/^[ \t]+rapier_jxl:$/.test(c.lines[0]) || !/^[ \t]+path: packages\/rapier_jxl$/.test(c.lines[1]))
      throw setup(`${recordPath} has an invalid config entry`, `fix or delete ${recordPath}`);
  }
  return parsed;
}

export async function runAddPlace(place, args, {cwd, version, stdout, packageDir}) {
  const given = flags(place, 'add', args);
  if (given.help) { stdout(HELP(place)); return; }
  const {dryRun, json} = given, spec = PLACES[place], found = await locate(place, cwd), root = await examples();
  const wanted = await spec.files(found, await prepared(place, root, await packageFolder(packageDir)), root);
  const recordPath = posix(join(spec.anchor(found), RECORD)), before = await recordOf(cwd, recordPath, place, spec, found);
  const changes = [], writes = new Map(), files = {...before?.files}, dirs = new Set(before?.dirs ?? []), next = [];
  for (const [path, bytes] of wanted) {
    const current = await read(join(cwd, path)), digest = sha(bytes), recorded = before?.files?.[path];
    if (current === null) { writes.set(path, bytes); files[path] = digest; changes.push({file: path, action: 'created'}); }
    else if (recorded && matchesDigest(current, digest)) { files[path] = digest; changes.push({file: path, action: 'unchanged'}); }
    else if (recorded && matchesDigest(current, recorded)) { writes.set(path, bytes); files[path] = digest; changes.push({file: path, action: 'updated'}); }
    else changes.push({file: path, action: recorded ? 'left (edited)' : 'left (already there)'});
  }
  let config = before?.config ?? null;
  if (spec.config) {
    const text = (await read(join(cwd, spec.config)))?.toString() ?? '', edit = pubspecAdd(text);
    if (edit && !edit.lines) changes.push({file: spec.config, action: 'unchanged'});
    else if (edit) { writes.set(spec.config, Buffer.from(edit.text)); config = {file: spec.config, lines: edit.lines}; changes.push({file: spec.config, action: 'updated: depends on packages/rapier_jxl'}); }
    else next.push(`add under dependencies in ${spec.config}:  rapier_jxl: {path: packages/rapier_jxl}`);
  }
  for (const path of [recordPath, ...writes.keys()]) for (let dir = dirname(path); dir !== '.'; dir = dirname(dir))
    if (!await present(join(cwd, dir))) dirs.add(posix(dir));
  const ordered = [[recordPath, Buffer.from(JSON.stringify({place, version, files, dirs: [...dirs].sort(), ...config && {config}}, null, 2) + '\n')], ...writes];
  const lands = await insideProject(cwd, ordered.map(([path]) => path), setup);
  for (const [i, [path]] of ordered.entries()) await refuseReadOnly(lands[i], path);
  if (!dryRun) for (const [i, [, bytes]] of ordered.entries()) await atomicWrite(lands[i], bytes);
  next.push(...await spec.next(found, root, cwd));
  if (json) { stdout(JSON.stringify({type: 'add', place, dryRun, changes, next})); return; }
  for (const c of changes) stdout(`${c.file}: ${dryRun && !/^(unchanged|left)/.test(c.action) ? 'would be ' : ''}${c.action}`);
  for (const n of next) stdout('next: ' + n);
}

export async function runRemovePlace(place, args, {cwd, stdout}) {
  const given = flags(place, 'remove', args);
  if (given.help) { stdout(HELP(place)); return; }
  const {dryRun, json} = given, spec = PLACES[place], found = await locate(place, cwd);
  const recordPath = posix(join(spec.anchor(found), RECORD)), record = await recordOf(cwd, recordPath, place, spec, found);
  if (!record) throw setup(`${place}: no record to remove`, 'nothing to remove; delete any files you added by hand');
  const fileEntries = Object.entries(record.files), dirList = [...record.dirs];
  const fileLands = await insideProject(cwd, fileEntries.map(([p]) => p), setup);
  const dirLands = await insideProject(cwd, dirList, setup);
  const [recordLand, ...configLands] = await insideProject(cwd, [recordPath, ...(record.config ? [record.config.file] : [])], setup);
  const changes = [], deletes = [];
  let edited = null;
  if (record.config) {
    const text = (await read(configLands[0]))?.toString() ?? null, without = text !== null ? pubspecRemove(text, record.config.lines) : null;
    if (typeof without === 'string') { edited = {file: record.config.file, land: configLands[0], text: without}; changes.push({file: edited.file, action: 'updated: no longer depends on packages/rapier_jxl'}); }
    else if (text === null || !/^[ \t]*rapier_jxl\s*:/m.test(text)) changes.push({file: record.config.file, action: 'already gone'});
    else throw setup(`${record.config.file} was edited and still depends on packages/rapier_jxl`, `remove rapier_jxl from ${record.config.file}, then run npx ${COMMAND} remove ${place}`);
  }
  for (const [i, [path, digest]] of fileEntries.entries()) {
    const current = await read(fileLands[i]);
    if (current === null) changes.push({file: path, action: 'already gone'});
    else if (matchesDigest(current, digest)) { deletes.push(fileLands[i]); changes.push({file: path, action: 'removed'}); }
    else changes.push({file: path, action: 'left (edited)'});
  }
  if (!dryRun) {
    for (const land of deletes) await rm(land, {force: true});
    if (edited) await atomicWrite(edited.land, edited.text);
    if (!changes.some(c => c.action === 'left (edited)')) {
      await rm(recordLand, {force: true});
      const order = dirList.map((d, i) => [d, dirLands[i]]).sort((a, b) => b[0].length - a[0].length);
      for (const [, land] of order) await rmdir(land).catch(() => {});
    }
  }
  if (json) { stdout(JSON.stringify({type: 'remove', place, dryRun, changes})); return; }
  for (const c of changes) stdout(`${c.file}: ${dryRun && c.action === 'removed' ? 'would be ' : ''}${c.action}`);
}
