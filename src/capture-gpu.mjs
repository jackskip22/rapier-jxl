// SPDX-License-Identifier: MIT
let pending;
/** Optional device: failure or device loss always leaves a CPU path. */
export async function optionalDevice() {
  if (!globalThis.navigator?.gpu) return null;
  pending ||= (async () => {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      device.lost.then(() => { pending = undefined; });
      return device;
    } catch { return null; }
  })();
  return pending;
}

const shader = `
struct Params { count:u32, step:u32, error:u32, columns:u32 }
@group(0) @binding(0) var<storage,read> source:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputPixels:array<u32>;
@group(0) @binding(2) var<uniform> p:Params;
fn quant(v:u32)->u32 { return min(255u, ((v+p.error)/p.step)*p.step); }
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
  let i=id.x+id.y*p.columns*256u;
  if(i>=p.count){return;}
  let v=source[i];
  if((v>>24u)==0u){outputPixels[i]=v;return;}
  outputPixels[i]=(v&0xff000000u)|quant(v&255u)|(quant((v>>8u)&255u)<<8u)|(quant((v>>16u)&255u)<<16u);
}`;
const pipelines = new WeakMap();

/** Integer-only quantization, identical to quantizeCapture. A null result asks the caller to use CPU. */
export async function quantizeCaptureGPU(data, maxError, given) {
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return null;
  const device = given ?? await optionalDevice();
  if (!device || data.byteLength > device.limits.maxStorageBufferBindingSize || data.byteLength > device.limits.maxBufferSize) return null;
  const buffers = [];
  try {
    let pipeline = pipelines.get(device);
    if (!pipeline) {
      pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: device.createShaderModule({code: shader}), entryPoint: 'main'}});
      pipelines.set(device, pipeline);
    }
    const make = (size, usage) => { const buffer = device.createBuffer({size, usage}); buffers.push(buffer); return buffer; };
    const input = make(data.byteLength, 128 | 8), output = make(data.byteLength, 128 | 4), params = make(16, 64 | 8), readback = make(data.byteLength, 1 | 8);
    const count = data.byteLength / 4, groups = Math.ceil(count / 256), columns = Math.min(groups, device.limits.maxComputeWorkgroupsPerDimension);
    device.queue.writeBuffer(input, 0, data);
    device.queue.writeBuffer(params, 0, new Uint32Array([count, 2 * maxError + 1, maxError, columns]));
    const bind = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [input, output, params].map((buffer, binding) => ({binding, resource: {buffer}}))});
    const commands = device.createCommandEncoder(), pass = commands.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(columns, Math.ceil(groups / columns)); pass.end();
    commands.copyBufferToBuffer(output, 0, readback, 0, data.byteLength); device.queue.submit([commands.finish()]);
    await readback.mapAsync(1);
    const result = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();
    return result;
  } catch { return null; }
  finally { for (const buffer of buffers) buffer.destroy(); }
}
