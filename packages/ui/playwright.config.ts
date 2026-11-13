import { defineConfig } from '@playwright/test';

const port = Number(process.env.NEBULUME_PLAYWRIGHT_PORT || 45173);
const url = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results',
  timeout: 30_000,
  use: {
    baseURL: url,
    channel: process.env.NEBULUME_BROWSER_CHANNEL || undefined,
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    url,
    timeout: 10_000,
    reuseExistingServer: false,
  },
});
