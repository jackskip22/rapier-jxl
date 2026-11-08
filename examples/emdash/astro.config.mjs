import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import {d1, r2} from '@emdash-cms/cloudflare';
import {defineConfig} from 'astro/config';
import emdash from 'emdash/astro';
import {jxl} from 'rapier-jxl/emdash';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [react(), jxl(emdash, {database: d1({binding: 'DB'}), storage: r2({binding: 'MEDIA'})})],
  devToolbar: {enabled: false}
});
