/**
 * Playwright configuration.
 *
 * E2E runs against real dev servers with their own databases and blob directories, so a
 * run can never touch a developer's local data.
 *
 * Each project gets its **own** server and database. Two projects sharing one database
 * looked fine until both ran in the same invocation: the second project inherited the
 * first project's agents, services and models, so its "nothing here yet" assertions
 * failed for reasons that had nothing to do with the code under test. Isolating them
 * keeps those assertions meaningful and lets the projects run in any order.
 */

import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const E2E_ROOT = path.resolve(process.cwd(), '.e2e');

interface Target {
  project: string;
  port: number;
}

/** One isolated server per project. */
const TARGETS: Target[] = [
  { project: 'chromium', port: Number(process.env.MENTAT_E2E_PORT ?? 5373) },
  { project: 'chromium-narrow', port: Number(process.env.MENTAT_E2E_NARROW_PORT ?? 5374) }
];

export function baseUrlFor(projectName: string): string {
  const target = TARGETS.find((entry) => entry.project === projectName) ?? TARGETS[0];
  return `http://127.0.0.1:${target?.port ?? 5373}`;
}

/**
 * A fixed, valid 32-byte key so a rerun can still decrypt the secrets it created.
 * Both servers share it because the sessions and secrets they write are throwaway.
 */
const MASTER_KEY = 'vaIhKUcfE8H71v5zVkOloabeHdxHu49ZTFi1rR5fuRs=';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  // A dev server compiles each route on first request, so the first action on a page
  // can legitimately take a few seconds. These are ceilings, not targets: with two
  // isolated servers running in one invocation, 10s proved tight under load.
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000
  },
  projects: TARGETS.map((target) => ({
    name: target.project,
    use: {
      ...devices['Desktop Chrome'],
      // The narrow project is the guard that the UI holds up when space is tight.
      ...(target.project === 'chromium-narrow' ? { viewport: { width: 900, height: 900 } } : {}),
      baseURL: baseUrlFor(target.project)
    }
  })),
  webServer: TARGETS.map((target) => {
    const baseUrl = baseUrlFor(target.project);
    return {
      // Bind explicitly to IPv4: `localhost` can resolve to ::1, which the health check
      // (and the browser) would then miss.
      command: `bun run dev --host 127.0.0.1 --port ${target.port}`,
      url: baseUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
      env: {
        NODE_ENV: 'development',
        MENTAT_DB_PATH: path.join(E2E_ROOT, `${target.project}.db`),
        MENTAT_BLOB_ROOT: path.join(E2E_ROOT, `${target.project}-blobs`),
        MENTAT_DATA_DIR: path.join(E2E_ROOT, target.project),
        MENTAT_WORKER_ENABLED: 'true',
        MENTAT_WORKER_CONCURRENCY: '2',
        MENTAT_BASE_URL: baseUrl,
        MENTAT_LOG_LEVEL: 'warn',
        MENTAT_MASTER_KEY: MASTER_KEY
      }
    };
  })
});
