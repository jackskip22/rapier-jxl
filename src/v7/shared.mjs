import {createEncoder as createClient} from './client.mjs';

let shared;
export function sharedClient() { return shared ||= createClient(); }
