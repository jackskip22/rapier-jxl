/*! rapier-jxl 8.3.4 | MIT */
function r(t){try{t!==null&&(typeof t=="object"||typeof t=="function")&&e.add(t)}catch{}return t}
function n(e){if(e!==void 0){if(!e||typeof e!="object"&&typeof e!="function"||typeof e.aborted!="boolean"||typeof e.addEventListener!="function")throw t("JXL_OPTIONS","signal must be an AbortSignal.");return e}}
function o(e){if(e==null)return;let n,o;try{n=e.aborted,n&&(o=e.reason)}catch(t){throw r(t)}if(n)throw o===void 0?t("JXL_ABORTED","The job was aborted."):r(o)}
function a(e,r="Options"){if(e===void 0)return{};if(!e||typeof e!="object"||Array.isArray(e))throw t("JXL_OPTIONS",`${r} must be an object.`);return e}
function l(t){if(ArrayBuffer.isView(t))return null;try{return i.call(t)}catch{return null}}
function y(e,r=!1){if(u.call(e)!=="Uint8Array"||l(c.buffer.call(e))===null||!r&&c.byteLength.call(e)===0)throw t("JXL_INPUT","Encoded input is a nonempty Uint8Array on an ordinary ArrayBuffer.");return c.byteLength.call(e)}
function s(e,r=!1){y(e,r);try{return new Uint8Array(e)}catch{throw t("JXL_INPUT","Encoded input is a Uint8Array on an ordinary, attached ArrayBuffer.")}}
function h(e,r){let o=a(e);if(Object.values(Object.getOwnPropertyDescriptors(o)).some(t=>!("value"in t)))throw t("JXL_OPTIONS","Options cannot contain accessors.");let i={...o};for(let e of Object.keys(i))if(!r.includes(e))throw t("JXL_OPTIONS",`Unknown storage option: ${e}.`);return"signal"in i&&n(i.signal),i}
function p(e,r,n=b){if(e===void 0)return n;if(!Number.isSafeInteger(e)||e<1||e>b)throw t("JXL_OPTIONS",`${r} is a positive whole number, at most 256 MiB.`);return e}
function w(t){if(typeof Blob<"u"&&t instanceof Blob)return t.size;let e=l(t);return e!==null?e:ArrayBuffer.isView(t)?y(t,!0):null}
function O(t,e){if(t.length===1)return t[0];let r=new Uint8Array(e),n=0;for(let e of t)r.set(e,n),n+=e.length;return r}
function g(t,e){return e?(o(e),new Promise((r,n)=>{let a=()=>{i();try{o(e)}catch(t){n(t)}},i=()=>e.removeEventListener?.("abort",a);e.addEventListener("abort",a,{once:!0}),Promise.resolve(t).then(t=>{i(),r(t)},t=>{i(),n(t)}),e.aborted&&(i(),a())})):t}
async function L(e,r){let n=h(r,["maxBytes","signal"]),{signal:a}=n,i=p(n.maxBytes,"maxBytes");o(a);let f=w(e);if(f!==null&&f>i)throw t("JXL_LIMIT",`Object body exceeds maxBytes (${i}).`);if(typeof Blob<"u"&&e instanceof Blob){let t=new Uint8Array(await g(e.arrayBuffer(),a));return o(a),t}if(l(e)!==null)try{return new Uint8Array(new Uint8Array(e))}catch{throw t("JXL_INPUT","Object body uses an attached ArrayBuffer.")}if(ArrayBuffer.isView(e))return s(e,!0);if(!e||typeof e.getReader!="function")throw t("JXL_INPUT","Object body is bytes, a Blob or a byte stream.");let c=e.getReader(),u=[],b=0,L=!1;try{for(;;){o(a);let{done:e,value:r}=await g(c.read(),a);if(o(a),e)return L=!0,O(u,b);let n=y(r,!0);if(n>i-b)throw t("JXL_LIMIT",`Object body exceeds maxBytes (${i}).`);u.push(s(r,!0)),b+=n}}finally{if(!L)try{d(c.cancel(a?.aborted?a.reason:void 0))}catch{}try{c.releaseLock()}catch{}}}
var t=(t,e)=>Object.assign(new Error(e),{code:t});
var e=new WeakSet;
var i=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength").get,f=Object.getPrototypeOf(Uint8Array.prototype),c=Object.fromEntries(["buffer","byteOffset","byteLength"].map(t=>[t,Object.getOwnPropertyDescriptor(f,t).get])),u=Object.getOwnPropertyDescriptor(f,Symbol.toStringTag).get;
var b=256*1024*1024,d=t=>{Promise.resolve(t).catch(()=>{})};
export{L as readAll};