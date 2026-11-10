import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5173', channel: process.env.NEBULUME_BROWSER_CHANNEL || undefined, headless: true, viewport: { width: 1440, height: 960 }, screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
});
