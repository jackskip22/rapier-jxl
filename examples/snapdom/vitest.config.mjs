import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    include: ['examples/snapdom/__tests__/*.test.js'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { executablePath: process.env.CHROMIUM || undefined,
        args: ['--no-sandbox','--enable-features=JXL', ...(process.env.WEBGPU_SOFTWARE === '1' ? ['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader'] : [])] } }),
      instances: [{ browser:'chromium' }],
    },
  },
});
