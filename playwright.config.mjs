import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.mjs', timeout: 30000, workers: 1,
  use: { launchOptions: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, screenshot: 'only-on-failure' },
  outputDir: 'test-results',
  webServer: [5191, 5192].map(port => ({ command: 'node scripts/dev.mjs --fixture', env: { PORT: String(port) }, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 60000 })),
  projects: [
    { name: 'mobile', use: { baseURL: 'http://127.0.0.1:5191', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { baseURL: 'http://127.0.0.1:5192', viewport: { width: 1360, height: 1000 } } },
  ],
})
