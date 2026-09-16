/**
 * Playwright configuration.
 *
 * E2E runs against a real dev server with its own database and blob directory, so a
 * test run can never touch a developer's local data. The server is started once
 * (not per test file) and the global setup creates a signed-in session so specs can
 * begin at the board rather than at the login form.
 */

import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.MENTAT_E2E_PORT ?? 5373);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const E2E_ROOT = path.resolve(process.cwd(), '.e2e');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      // The UI must hold up at narrower widths; this project is the guard.
      name: 'chromium-narrow',
      use: { ...devices['Desktop Chrome'], viewport: { width: 900, height: 900 } }
    }
  ],
  webServer: {
    // Bind explicitly to IPv4: `localhost` can resolve to ::1, which the health check
    // below (and the browser) would then miss.
    command: `bun run dev --host 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'development',
      MENTAT_DB_PATH: path.join(E2E_ROOT, 'mentat-e2e.db'),
      MENTAT_BLOB_ROOT: path.join(E2E_ROOT, 'blobs'),
      MENTAT_DATA_DIR: E2E_ROOT,
      MENTAT_WORKER_ENABLED: 'true',
      MENTAT_WORKER_CONCURRENCY: '2',
      MENTAT_BASE_URL: BASE_URL,
      MENTAT_LOG_LEVEL: 'warn',
      // A fixed, valid 32-byte key so a rerun can still decrypt its own secrets.
      MENTAT_MASTER_KEY: 'vaIhKUcfE8H71v5zVkOloabeHdxHu49ZTFi1rR5fuRs='
    }
  }
});
