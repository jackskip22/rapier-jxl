// SPDX-License-Identifier: MIT
// The same tools for an Agent class, as AI SDK tools: pass them to streamText.
//   import {jxlAgentTools} from './jxl-agent.mjs';
//   streamText({model, messages, tools: jxlAgentTools(this.env)})   // in onChatMessage of an AIChatAgent
import {tool} from 'ai';
import {z} from 'zod';
import {defineTools, runTool} from './jxl-tools.mjs';

export const jxlAgentTools = env => Object.fromEntries(defineTools(z).map(t =>
  [t.name, tool({description: t.description, inputSchema: t.input, execute: async args => (await runTool(t, env, args)).content[0].text})]));
