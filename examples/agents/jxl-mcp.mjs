// SPDX-License-Identifier: MIT
// A stateless MCP server of JPEG XL tools (agents/mcp/server createMcpHandler: no Durable Object). In the Worker's fetch:
//   import {jxlMcp} from './jxl-mcp.mjs';
//   if (new URL(request.url).pathname === '/mcp') return jxlMcp(request, env, ctx);
import {McpServer} from '@modelcontextprotocol/server';
import {createMcpHandler} from 'agents/mcp/server';
import {z} from 'zod';
import {defineTools, runTool} from './jxl-tools.mjs';

const MAX_BODY_BYTES = 262_144;

function payloadTooLarge() {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    error: {code: -32600, message: `JXL_LIMIT: MCP request body exceeds ${MAX_BODY_BYTES} bytes; pass R2 object keys, not file bytes.`},
    id: null,
  }), {status: 413, headers: {'content-type': 'application/json'}});
}

async function boundedRequest(request, maxBytes) {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) return null;
  }
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { merged.set(chunk, at); at += chunk.byteLength; }
  return new Request(request.url, {method: request.method, headers: request.headers, body: merged});
}

export async function jxlMcp(request, env, ctx, options) {
  // A call names objects by key: its body is small, and one past MAX_BODY_BYTES is refused before it is held whole.
  const bounded = await boundedRequest(request, MAX_BODY_BYTES);
  if (!bounded) return payloadTooLarge();
  const tools = defineTools(z);
  const server = () => {
    const mcp = new McpServer({name: 'rapier-jxl', version: '1.0.0'});
    for (const tool of tools) mcp.registerTool(tool.name, {description: tool.description, inputSchema: tool.input}, args => runTool(tool, env, args));
    return mcp;
  };
  return createMcpHandler(server, {route: '/mcp', ...options})(bounded, env, ctx);
}
