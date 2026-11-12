// Types for index.mjs, beside it. No EmDash or Astro types are needed to read them.
type StorageDescriptor = {entrypoint: string; config?: object};
/** The deployed host's real allowances. Omit cpuLimitMs when the host does not specify one.
 * Cloudflare memory defaults to its 128 MiB isolate limit; Node has no inherited Worker limit. */
export interface HostLimits {cpuLimitMs?: number; memoryLimitBytes?: number}
/** EmDash's integration with its r2() or local() storage wrapped and the JPEG XL plug-in added, then the
 *  integration that serves JPEG XL where the browser shows it. */
export function jxl<Config extends {storage: StorageDescriptor; plugins?: readonly unknown[]}, Integration>(
  emdash: (config: Config) => Integration, config: Config, limits?: HostLimits): [Integration, {name: 'rapier-jxl'; hooks: object}];
