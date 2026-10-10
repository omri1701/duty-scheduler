import {defineConfig} from '@playwright/test';

const external = process.env.DUTY_E2E_URL;
export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  updateSnapshots: 'none',
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  timeout: 60_000,
  expect: {timeout: 8_000, toHaveScreenshot: {animations: 'disabled', caret: 'hide', maxDiffPixels: 0}},
  snapshotPathTemplate: '{testDir}/snapshots/{platform}/{projectName}/{arg}{ext}',
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    baseURL: external ?? 'http://127.0.0.1:8787',
    locale: 'en-GB', timezoneId: 'Asia/Jerusalem', colorScheme: 'light',
    reducedMotion: 'reduce', serviceWorkers: 'block', deviceScaleFactor: 1,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  projects: [
    {name: 'desktop', use: {browserName: 'chromium', viewport: {width: 1440, height: 1000}}},
    {name: 'mobile', use: {browserName: 'chromium', viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 1}},
  ],
  webServer: external ? undefined : {
    command: 'node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 8787', url: 'http://127.0.0.1:8787',
    reuseExistingServer: false, timeout: 120_000,
  },
});
