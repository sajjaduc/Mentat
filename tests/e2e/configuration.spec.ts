/**
 * E2E coverage for the configuration surfaces.
 *
 * One account is registered per worker in `beforeAll` (through the real API) and its
 * session cookie is handed to every test, so each spec starts signed in while the
 * expensive, stateful registration happens once. Fixture names carry a unique suffix, so
 * sharing the account does not couple the tests.
 *
 * The HTTP test is the flagship: it runs a real Test Request against Mentat's own `/api`
 * index, which exercises request building, success rules, the response pane, redaction
 * and the request log without depending on an external network. The provider flow uses
 * the deterministic `fake` provider for the same reason — it is reachable and healthy,
 * yet discovers no models, which is exactly the "no models yet" path the UI must explain.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { apiCall, createWorkflow, registerAndSignIn, signInBrowser, uniqueSuffix } from './helpers';

interface SharedSession {
  cookie: string;
  workspaceId: string;
}

let session: SharedSession | null = null;

/** `.e2e` is the run directory the Playwright config points the server at. */
function sessionPath(): string {
  return path.resolve(process.cwd(), '.e2e', 'configuration-session.json');
}

function readSharedSession(): SharedSession | null {
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(), 'utf8')) as Partial<SharedSession>;
    return typeof parsed.cookie === 'string' && typeof parsed.workspaceId === 'string'
      ? { cookie: parsed.cookie, workspaceId: parsed.workspaceId }
      : null;
  } catch {
    return null;
  }
}

function writeSharedSession(value: SharedSession): void {
  try {
    mkdirSync(path.dirname(sessionPath()), { recursive: true });
    writeFileSync(sessionPath(), JSON.stringify(value));
  } catch {
    // The cache is an optimisation; a read-only filesystem must not fail the run.
  }
}

async function sessionIsValid(request: APIRequestContext, cookie: string): Promise<boolean> {
  try {
    const response = await request.get('/api/auth/me', { headers: { cookie } });
    if (!response.ok()) return false;
    const body = (await response.json()) as { workspace?: { id?: string } | null };
    // A session without a workspace cannot act on anything, so it is not reusable.
    return Boolean(body.workspace?.id);
  } catch {
    return false;
  }
}

// Registration is the one stateful step: a fresh instance creates a starter workspace for
// its first account, and later registrations do not. Reusing a persisted session keeps the
// whole file on one account across worker restarts and repeated runs.
test.beforeAll(async ({ playwright }) => {
  const port = process.env.MENTAT_E2E_PORT ?? '5373';
  const request = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${port}` });
  try {
    const stored = readSharedSession();
    if (stored && (await sessionIsValid(request, stored.cookie))) {
      session = stored;
      return;
    }
    const created = await registerAndSignIn(request);
    session = { cookie: created.cookie, workspaceId: created.workspaceId };
    writeSharedSession(session);
  } finally {
    await request.dispose();
  }
});

test.beforeEach(async ({ page }) => {
  if (!session) throw new Error('The shared E2E session was not created.');
  await signInBrowser(page, session);
});

test('HTTP services: create a service, build an operation, run a test request', async ({
  page
}) => {
  const name = `E2E Service ${uniqueSuffix()}`;

  await page.goto('/http-services');
  // Waiting on the empty state proves the client-side load (and hydration) finished.
  await expect(page.getByText('No HTTP services yet')).toBeVisible({ timeout: 15_000 });
  const origin = new URL(page.url()).origin;
  await page.getByRole('button', { name: 'New service' }).click();
  const dialog = page.getByRole('dialog').last();
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Base URL').fill(origin);
  await dialog.getByRole('button', { name: 'Create service' }).click();

  await page.waitForURL(/\/http-services\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Connection' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Operations' })).toBeVisible();

  // Exercise the editor against Mentat's own reachable JSON endpoint.
  await page.getByRole('button', { name: 'New operation' }).first().click();
  await page.waitForURL(/\/operations\/new$/);
  await page.getByLabel('Path template').fill('/api');
  await page.getByRole('tab', { name: 'Advanced' }).click();
  await page.getByLabel('Tool key').fill(`e2e.api.${uniqueSuffix().replace(/-/g, '.')}`);
  await page.getByLabel('Display name').fill('API index');
  await page.getByRole('button', { name: 'Create operation' }).click();
  await page.waitForURL(/\/operations\/[0-9a-fA-F-]{20,}$/, { timeout: 20_000 });

  for (const tab of [
    'Parameters',
    'Headers',
    'Body',
    'Response',
    'Cache',
    'Retries',
    'Approval',
    'Advanced'
  ]) {
    await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  }

  // The cache tab states the credential-identity rule plainly.
  await page.getByRole('tab', { name: 'Cache' }).click();
  await expect(page.getByText(/fingerprint of the credential/i)).toBeVisible();

  // The console runs the persisted definition and shows the redacted exchange.
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('cache bypass')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/"routes"/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy as cURL' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy as fetch' })).toBeVisible();
});

test('Models & providers: fake provider, connection test, hand-registered model', async ({
  page
}) => {
  const providerName = `E2E Fake ${uniqueSuffix()}`;
  const modelKey = `e2e-model-${uniqueSuffix()}:1b`;

  await page.goto('/models');
  await expect(page.getByRole('heading', { name: 'Models & providers' })).toBeVisible();
  await expect(page.getByText('No models yet').first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Add provider' }).click();

  const dialog = page.getByRole('dialog').last();
  await dialog.getByLabel('Type').selectOption('fake');
  await dialog.getByLabel('Name').fill(providerName);
  await dialog.getByRole('button', { name: 'Create provider' }).click();

  // The post-create step tests connectivity and reports reachable/unreachable.
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText(/healthy|reachable/i)).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(providerName)).toBeVisible();

  // A fake provider discovers no models, so registering one by hand is the path shown.
  await page.getByRole('button', { name: 'Register a model' }).first().click();
  const modelDialog = page.getByRole('dialog');
  await modelDialog.getByLabel('Model key').fill(modelKey);
  await modelDialog.getByLabel('Display name').fill('E2E Model');
  await modelDialog.getByRole('button', { name: 'Register model' }).click();
  await expect(page.getByText(modelKey)).toBeVisible({ timeout: 15_000 });

  // Ollama pre-fills the deployment's local URL from the suggest endpoint.
  await page.getByRole('button', { name: 'Add provider' }).click();
  const ollamaDialog = page.getByRole('dialog');
  await ollamaDialog.getByLabel('Type').selectOption('ollama');
  await expect(ollamaDialog.getByLabel('Base URL')).toHaveValue(/11434/, { timeout: 10_000 });
  await ollamaDialog.getByRole('button', { name: 'Cancel' }).click();
});

test('Agents: create an agent and inspect its configuration tabs', async ({ page }) => {
  const name = `E2E Agent ${uniqueSuffix()}`;

  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(page.getByText('No agents yet')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'New agent' }).click();

  const dialog = page.getByRole('dialog').last();
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await page.waitForURL(/\/agents\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name })).toBeVisible();

  for (const tab of [
    'Identity',
    'Skills',
    'Tools',
    'Permissions',
    'Execution',
    'Output schema',
    'Versions'
  ]) {
    await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  }

  // Nothing is granted by default, and the permission panel says so.
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(page.getByText(/granted/i).first()).toBeVisible();

  // The first immutable version is already recorded.
  await page.getByRole('tab', { name: 'Versions' }).click();
  await expect(page.getByText(/initial version/i).first()).toBeVisible();
});

test('Skills: create a skill and save an instruction change', async ({ page }) => {
  const name = `E2E Skill ${uniqueSuffix()}`;

  await page.goto('/skills');
  await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible();
  await expect(page.getByText('No skills yet')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'New skill' }).click();

  const dialog = page.getByRole('dialog').last();
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create skill' }).click();
  await page.waitForURL(/\/skills\/[^/]+$/, { timeout: 20_000 });

  await page.getByRole('tab', { name: 'Instructions' }).click();
  await page.getByLabel('Instructions').fill('Always cite the ticket key in the summary.');
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled({ timeout: 15_000 });
});

test('Tools: the catalogue explains native capabilities and stored tools', async ({ page }) => {
  await page.goto('/tools');
  await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
  // The native registry always reports capabilities; waiting for one proves the load ran.
  await expect(page.getByText(/mentat\./).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Native capabilities').first()).toBeVisible();
  await expect(page.getByText('Stored tools')).toBeVisible();
  // A native tool key and the enforcement note are shown so an operator can grant them.
  await expect(page.getByText(/mentat\.ticket|ticket:read/).first()).toBeVisible();
  await expect(page.getByText(/approval is enforced/i).first()).toBeVisible();
});

test('Integrations: providers, HTTP services and a cron trigger', async ({ page, request }) => {
  const workflowName = `E2E Workflow ${uniqueSuffix()}`;
  await createWorkflow(request, workflowName, 'basic');

  await page.goto('/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
  await expect(page.getByText('No providers yet')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Providers', { exact: true })).toBeVisible();
  await expect(page.getByText('HTTP services', { exact: true })).toBeVisible();
  await expect(page.getByText('Triggers', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New trigger' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('Name').fill(`E2E Cron ${uniqueSuffix()}`);
  await drawer.getByLabel('Type').selectOption('cron');
  await drawer.getByLabel('Workflow').selectOption({ label: workflowName });
  await drawer.getByLabel('Cron expression').fill('0 9 * * 1-5');
  // The editor describes the schedule and previews its next three runs.
  await expect(drawer.getByText(/every week on monday/i)).toBeVisible();
  await expect(drawer.getByText(/next three runs/i)).toBeVisible();
  await drawer.getByRole('button', { name: 'Create trigger' }).click();

  // The list resolves the persisted schedule.
  await expect(page.getByText(/next run/i).first()).toBeVisible({ timeout: 15_000 });
});

test('An HTTP service can be archived from its page', async ({ page, request }) => {
  const name = `E2E Archive ${uniqueSuffix()}`;
  const created = await apiCall<{ service: { id: string } }>(request, 'POST', '/http/services', {
    data: { name, baseUrl: 'https://example.test' }
  });

  await page.goto(`/http-services/${created.service.id}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Confirm archive' }).click();

  await page.waitForURL(/\/http-services$/, { timeout: 20_000 });
  await expect(page.getByText(name)).toHaveCount(0);
});
