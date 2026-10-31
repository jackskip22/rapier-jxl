import {BUILD_VERSION} from './build-version.mjs';
const supplied = new Map(), used = new Map(), BUNDLE = Symbol.for('rapier-jxl.wasm');
let configured = false, sealed = false;
const error = message => Object.assign(new Error(message), {code: 'JXL_WASM'});
const exportsFor = {
  capture: 'weighted copies runs scan tally part literals pieces',
  simd: 'residual fill screen sampled dct xybTile quantTile acGroup ansFlush nonzeroCounts subtract vbDct vbQuant gab sgFill xybRows acTokens gabTiles fgXyb gab32 fgTiles tokens weighted',
  jpeg: 'memory initTable terms seedBest pairsInit pairsUpdate pairMin assign ansFlush fill scanStart scanBand decodeStart decodeBand tokensIn prefixWrite literalClusters countFilled countClear recips mbits mwrite mtags seedAll priceConfigs',
  decode: 'memory idct idct8 gab epf1 xyb srgb rgba8 store coefficients modular block8 dequant cfl64',
};

const MODULES = Symbol.for('rapier-jxl/' + BUILD_VERSION + ' wasm ' + Object.entries(exportsFor).map(([name, list]) => name + ':' + list).join(';'));

export function wasmBundle(modules) {
  return Object.freeze(Object.defineProperty({[BUNDLE]: true}, MODULES, {value: modules ? Object.freeze({...modules}) : null}));
}

export function configureWasm(bundle) {
  const object = bundle !== null && typeof bundle === 'object', field = object ? Object.getOwnPropertyDescriptor(bundle, MODULES) : undefined;
  const modules = field && 'value' in field ? field.value : undefined;
  if (modules !== null && (modules === undefined || typeof modules !== 'object')) throw error(object && Object.hasOwn(bundle, BUNDLE)
    ? 'This WebAssembly bundle comes from another version of rapier-jxl. Import rapier-jxl/wasm from this package.'
    : 'configureWasm takes the bundle exported by rapier-jxl/wasm.');
  if (modules) configureModules(modules);
}

export function configureModules(modules) {
  if (!modules || typeof modules !== 'object' || Array.isArray(modules) || !Object.keys(modules).length)
    throw error('Supply named precompiled WebAssembly.Module objects.');
  const entries = Object.entries(modules);
  for (const [name, module] of entries) {
    const expected = Object.hasOwn(exportsFor, name) ? exportsFor[name].split(' ') : null;
    if (!expected) throw error(`Unknown WebAssembly module: ${name}.`);
    let imports, exports;
    try { imports = WebAssembly.Module.imports(module); exports = WebAssembly.Module.exports(module); }
    catch { throw error(`${name} must be a precompiled WebAssembly.Module, not bytes or an instance.`); }
    const importedMemory = ['capture','simd'].includes(name);
    if (exports.length !== expected.length || expected.some(key => !exports.some(value => value.name === key && value.kind === (key === 'memory' ? 'memory' : 'function'))) ||
        (importedMemory ? imports.length !== 1 || imports[0].module !== 'env' || imports[0].name !== 'memory' || imports[0].kind !== 'memory' : imports.length !== 0))
      throw error(`The ${name} module has a different interface. Use the module shipped with this package.`);
    if (sealed && supplied.get(name) !== module || supplied.has(name) && supplied.get(name) !== module || used.has(name) && used.get(name) !== module)
      throw error(`The ${name} module is already selected in this realm. Configure modules before starting workers, probing, preparing or encoding.`);
  }
  for (const [name, module] of entries) supplied.set(name, module);
  configured = true;
}

export function suppliedWasm(seal = false) {
  if (seal) sealed = true;
  return configured ? Object.freeze(Object.fromEntries(supplied)) : undefined;
}
export const hasWasmModule = name => supplied.has(name);
const compiling = new Map();
export async function compileWasm(name, bytes) {
  if (used.get(name) || supplied.has(name)) return true;
  if (configured) throw error(`The precompiled ${name} module is missing. Supply the module shipped with this package.`);
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.compile !== 'function') return false;
  if (!compiling.has(name)) {
    if (!used.has(name)) used.set(name, null);
    compiling.set(name, WebAssembly.compile(bytes()).then(module => { if (!used.get(name)) used.set(name, module); return true; }, () => { compiling.delete(name); return false; }));
  }
  return compiling.get(name);
}
export function wasmModule(name, bytes) {
  if (used.get(name)) return used.get(name);
  used.set(name, null);
  const module = supplied.get(name);
  if (module) { used.set(name, module); return module; }
  if (configured) throw error(`The precompiled ${name} module is missing. Supply the module shipped with this package.`);
  const compiled = new WebAssembly.Module(bytes());
  used.set(name, compiled);
  return compiled;
}
configureWasm[Symbol.for('rapier-jxl.wasm-supplied')] = seal => suppliedWasm(seal);
