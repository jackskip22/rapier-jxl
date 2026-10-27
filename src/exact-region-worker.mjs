// SPDX-License-Identifier: MIT
import {runJob} from './exact-region.mjs';

self.onmessage = ({data}) => {
  try { self.postMessage({id: data.id, result: runJob(data)}); } catch (error) { self.postMessage({id: data.id, error: String(error?.stack ?? error)}); }
};
