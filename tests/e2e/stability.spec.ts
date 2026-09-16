/**
 * Surface stability.
 *
 * Every page must settle. A surface that keeps re-rendering after its data has
 * arrived is janky for a person, detaches controls out from under them mid-click, and
 * — as this suite found — makes an element unreachable to automation because it is
 * never "stable".
 *
 * Each surface is visited, given time to settle, and then watched with a
 * MutationObserver for a quiet period. Idle pages are expected to be silent; a handful
 * of mutations are tolerated for a late timer or a live-region tick, but continuous
 * churn fails.
 */
import { expect, test } from '@playwright/test';
import {
  apiCall,
  projectBaseUrl,
  registerAndSignIn,
  signInThroughForm,
  useSessionCookie
} from './helpers';

const account = {
  email: 'stability@mentat.test',
  name: 'Stability Owner',
  password: 'mentat-e2e-password',
  workspaceName: 'Stability Workspace'
};

/** Mutations tolerated while idle; anything more means the page is not settling. */
const QUIET_BUDGET = 6;

const SETTLE_MS = 2_000;
const WATCH_MS = 2_000;

let workflowId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: projectBaseUrl() });
  try {
    const session = await registerAndSignIn(request, account).catch(async () => {
      const response = await request.post('/api/auth/login', {
        data: { email: account.email, password: account.password }
      });
      const body = (await response.json()) as { workspaces?: Array<{ workspaceId: string }> };
      const workspaceId = body.workspaces?.[0]?.workspaceId;
      if (!workspaceId) throw new Error('the stability account has no workspace');
      useSessionCookie(response.headers()['set-cookie']?.split(';')[0] ?? '');
      return { workspaceId };
    });
    void session;

    const workflows = await apiCall<{ workflows: Array<{ id: string; name: string }> }>(
      request,
      'GET',
      '/workflows'
    );
    const existing = workflows.workflows.find((workflow) => workflow.name.startsWith('Stability'));
    workflowId =
      existing?.id ??
      (
        await apiCall<{ workflow: { id: string } }>(request, 'POST', '/workflows', {
          data: { name: `Stability ${Date.now().toString(36)}`, template: 'basic' }
        })
      ).workflow.id;
  } finally {
    await request.dispose();
  }
});

/** Watch a surface after it settles and return how much it mutated while idle. */
async function measureQuiet(page: import('@playwright/test').Page): Promise<number> {
  await page.waitForTimeout(SETTLE_MS);
  return page.evaluate(async (watchMs) => {
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    await new Promise((resolve) => setTimeout(resolve, watchMs));
    observer.disconnect();
    return mutations;
  }, WATCH_MS);
}

const surfaces: Array<{ path: () => string; name: string }> = [
  { name: 'workflows index', path: () => '/workflows' },
  { name: 'workflow board', path: () => `/workflows/${workflowId}?tab=board` },
  { name: 'workflow list', path: () => `/workflows/${workflowId}?tab=list` },
  { name: 'workflow activity', path: () => `/workflows/${workflowId}?tab=activity` },
  { name: 'workflow data', path: () => `/workflows/${workflowId}?tab=data` },
  { name: 'workflow configuration', path: () => `/workflows/${workflowId}?tab=configuration` },
  { name: 'my work', path: () => '/my-work' },
  { name: 'approvals', path: () => '/approvals' },
  { name: 'agents', path: () => '/agents' },
  { name: 'skills', path: () => '/skills' },
  { name: 'tools', path: () => '/tools' },
  { name: 'http services', path: () => '/http-services' },
  { name: 'files', path: () => '/files' },
  { name: 'models', path: () => '/models' },
  { name: 'dashboards', path: () => '/dashboards' },
  { name: 'data', path: () => '/data' },
  { name: 'integrations', path: () => '/integrations' },
  { name: 'settings', path: () => '/settings' },
  { name: 'settings members', path: () => '/settings/members' },
  { name: 'settings teams', path: () => '/settings/teams' },
  { name: 'settings secrets', path: () => '/settings/secrets' },
  { name: 'settings environment', path: () => '/settings/environment' },
  { name: 'settings overrides', path: () => '/settings/overrides' },
  { name: 'settings storage', path: () => '/settings/storage' },
  { name: 'settings jobs', path: () => '/settings/jobs' },
  { name: 'settings audit', path: () => '/settings/audit' }
];

test.beforeEach(async ({ page }) => {
  await signInThroughForm(page, account);
});

for (const surface of surfaces) {
  test(`${surface.name} settles`, async ({ page }) => {
    await page.goto(surface.path());
    // Wait for the surface to finish its first paint: either real content or an
    // explicit empty/error state, both of which mean the loader has completed.
    await page.waitForTimeout(700);

    const mutations = await measureQuiet(page);
    expect(
      mutations,
      `${surface.name} mutated ${mutations} times while idle (budget ${QUIET_BUDGET})`
    ).toBeLessThanOrEqual(QUIET_BUDGET);
  });
}

test('no surface logs an uncaught error', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(String(error).slice(0, 160)));

  for (const surface of surfaces) {
    await page.goto(surface.path());
    await page.waitForTimeout(400);
  }

  expect(failures, failures.join('\n')).toEqual([]);
});
