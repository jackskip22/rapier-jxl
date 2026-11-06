/*! rapier-jxl 8.3.0 | MIT */
function b(e){return Object.freeze(Object.defineProperty({[s]:!0},m,{value:e?Object.freeze({...e}):null}))}
function c(e){let r=e!==null&&typeof e=="object",t=r?Object.getOwnPropertyDescriptor(e,m):void 0,o=t&&"value"in t?t.value:void 0;if(o!==null&&(o===void 0||typeof o!="object"))throw i(r&&Object.hasOwn(e,s)?"This WebAssembly is from another rapier-jxl version; import rapier-jxl/wasm from this package.":"configureWasm takes the bundle exported by rapier-jxl/wasm.");o&&f(o)}
function f(e){if(!e||typeof e!="object"||Array.isArray(e)||!Object.keys(e).length)throw i("Supply named precompiled WebAssembly.Module objects.");let s=Object.entries(e);for(let[e,n]of s){if(!Object.hasOwn(r,e))throw i(`Unknown WebAssembly module: ${e}.`);let s,m;try{s=WebAssembly.Module.imports(n),m=WebAssembly.Module.exports(n)}catch{throw i(`${e} must be a compiled WebAssembly.Module.`)}let b=e==="kernels";if(t(m)!==r[e]||(b?s.length!==1||s[0].module!=="env"||s[0].name!=="memory"||s[0].kind!=="memory":s.length!==0))throw i(`The ${e} module does not match; use this package's.`);if(a&&o.get(e)!==n||o.has(e)&&o.get(e)!==n||l.has(e)&&l.get(e)!==n)throw i(`The ${e} module is already set; configure modules before any work.`)}for(let[e,r]of s)o.set(e,r);n=!0}
function u(e=!1){return e&&(a=!0),n?Object.freeze(Object.fromEntries(o)):void 0}
var e="8.3.0";
var r={kernels:"1wce05n",jpeg:"1qxvfd6",decode:"17x8vsf"};
var t=e=>{let r=2166136261;for(let t of e.map(e=>e.name+":"+e.kind).sort().join(" "))r=Math.imul(r^t.charCodeAt(0),16777619);return(r>>>0).toString(36)};
var o=new Map,l=new Map,s=Symbol.for("rapier-jxl.wasm"),n=!1,a=!1,i=e=>Object.assign(new Error(e),{code:"JXL_WASM"}),m=Symbol.for("rapier-jxl/"+e+" wasm "+Object.entries(r).map(([e,r])=>e+":"+r).join(";"));
c[Symbol.for("rapier-jxl.wasm-supplied")]=e=>u(e);
var p=b(null);
export{p as default};