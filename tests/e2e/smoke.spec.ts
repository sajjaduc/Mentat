/**
 * Core journey smoke test.
 *
 * A small, deliberately conservative spec that walks the definition-of-done path a
 * person actually takes: sign in, create a workflow from a template, see the board,
 * create a ticket in a column, move it from the keyboard-accessible menu, open the
 * ticket drawer, and reach the other primary surfaces.
 *
 * It is kept separate from the per-surface specs on purpose: those exercise far more
 * detail, and a failing detail should not hide whether the product works at all.
 * Locators here prefer roles and accessible names over test ids, so a rename that
 * breaks them is a real regression in the interface contract.
 */
import { expect, test } from '@playwright/test';
import { apiCall, registerAndSignIn, signInThroughForm, useSessionCookie } from './helpers';

/** A fixed account so a warm `.e2e` database can be signed into rather than needing a wipe. */
const account = {
  email: 'smoke@mentat.test',
  name: 'Smoke Owner',
  password: 'mentat-e2e-password',
  workspaceName: 'Smoke Workspace'
};

test.describe.configure({ mode: 'serial' });

let workspaceId: string;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5373' });
  try {
    const session = await registerAndSignIn(request, account).catch(async () => {
      const response = await request.post('/api/auth/login', {
        data: { email: account.email, password: account.password }
      });
      const body = (await response.json()) as { workspaces?: Array<{ workspaceId: string }> };
      const workspace = body.workspaces?.[0]?.workspaceId;
      if (!workspace) throw new Error('The smoke account exists but has no workspace');
      useSessionCookie(response.headers()['set-cookie']?.split(';')[0] ?? '');
      return { workspaceId: workspace };
    });
    workspaceId = session.workspaceId;
    expect(workspaceId, 'the smoke account has a workspace').toBeTruthy();
  } finally {
    await request.dispose();
  }
});

test('1. a person can sign in through the form', async ({ page }) => {
  await signInThroughForm(page, account);
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
});

test('2. a workflow can be created from a template and lands on its board', async ({ page }) => {
  await signInThroughForm(page, account);

  await page.getByRole('button', { name: 'Create workflow' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const name = `Smoke workflow ${Date.now().toString(36)}`;
  await dialog.getByLabel('Name', { exact: true }).first().fill(name);
  await dialog.getByRole('button', { name: /create and open board/i }).click();

  // The board is the primary surface: columns must be visible immediately, even with
  // no tickets, because the per-column + is how the first ticket gets created.
  await expect(page.getByTestId('board-column').first()).toBeVisible({ timeout: 20_000 });
  const columns = page.getByTestId('board-column');
  expect(await columns.count()).toBeGreaterThanOrEqual(3);
  await expect(columns.first()).toContainText('Backlog');
});

test('3. a ticket is created in a column and can be moved from the card menu', async ({ page }) => {
  await signInThroughForm(page, account);

  // Seeded through the API so the test focuses on the board interaction itself.
  const name = `Board ${Date.now().toString(36)}`;
  const created = await apiCall<{
    workflow: { id: string };
    states: Array<{ id: string; name: string }>;
  }>(page.request, 'POST', '/workflows', { data: { name, template: 'basic' } });
  const workflowId = created.workflow.id;

  await page.goto(`/workflows/${workflowId}?tab=board`);
  await expect(page.getByTestId('board-column').first()).toBeVisible({ timeout: 20_000 });

  // Create inline from the first column.
  const firstColumn = page.getByTestId('board-column').first();
  await firstColumn.getByRole('button', { name: /^Add ticket to/ }).click();
  const title = `Smoke ticket ${Date.now().toString(36)}`;
  await firstColumn.getByLabel('New ticket title').fill(title);
  await firstColumn.getByRole('button', { name: /^(Add|Create)$/ }).click();
  const card = page.getByTestId('board-card').filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Move it using the keyboard-reachable menu: this is the path that must work even
  // for someone who never drags a card.
  await card.getByRole('button', { name: 'Card actions' }).click();
  const moveItem = card
    .locator('button')
    .filter({ hasText: /Start|Move to/i })
    .last();
  await expect(moveItem).toBeVisible();
  await moveItem.click();

  await expect(
    page.getByTestId('board-column').nth(1).getByTestId('board-card').filter({ hasText: title })
  ).toBeVisible({ timeout: 15_000 });
});

test('4. the ticket drawer is URL-addressed and its tabs work', async ({ page }) => {
  await signInThroughForm(page, account);

  const created = await apiCall<{
    workflow: { id: string };
    states: Array<{ id: string; name: string }>;
  }>(page.request, 'POST', '/workflows', {
    data: { name: `Drawer ${Date.now().toString(36)}`, template: 'basic' }
  });
  const ticket = await apiCall<{ ticket: { id: string; key: string } }>(
    page.request,
    'POST',
    '/tickets',
    {
      data: {
        workflowId: created.workflow.id,
        stateId: created.states[0]?.id,
        title: 'Drawer smoke ticket'
      }
    }
  );

  await page.goto(`/workflows/${created.workflow.id}?tab=board`);
  // The title is the card's primary action; clicking the card body is not.
  await page
    .getByTestId('board-card')
    .filter({ hasText: 'Drawer smoke ticket' })
    .first()
    .getByRole('button')
    .first()
    .click();

  // The open ticket lives in the URL, so a reload restores it.
  await expect(page).toHaveURL(new RegExp(`ticket=${ticket.ticket.id}`));
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(ticket.ticket.key);

  for (const tab of ['Overview', 'Agent Work', 'Activity', 'Artifacts']) {
    await drawer.getByRole('tab', { name: tab }).click();
    await expect(drawer.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  }

  await page.reload();
  await expect(page.getByRole('dialog')).toContainText(ticket.ticket.key);
});

test('5. the other primary surfaces load without an error state', async ({ page }) => {
  await signInThroughForm(page, account);

  const surfaces: Array<{ path: string; heading: RegExp }> = [
    { path: '/my-work', heading: /my work/i },
    { path: '/approvals', heading: /approvals/i },
    { path: '/agents', heading: /agents/i },
    { path: '/files', heading: /files/i },
    { path: '/models', heading: /models/i },
    { path: '/http-services', heading: /http services/i },
    { path: '/dashboards', heading: /dashboards/i },
    { path: '/settings', heading: /settings|workspace/i }
  ];

  for (const surface of surfaces) {
    await page.goto(surface.path);
    await expect(page.getByRole('heading', { name: surface.heading }).first()).toBeVisible({
      timeout: 20_000
    });
    // No surface may render the generic failure copy.
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  }
});

test('6. a secret is written but never rendered back', async ({ page }) => {
  await signInThroughForm(page, account);
  await page.goto('/settings/secrets');

  const plaintext = `sk-smoke-${Date.now().toString(36)}-secret`;
  await page.getByRole('button', { name: /new secret|add secret/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel(/key/i)
    .first()
    .fill(`SMOKE_${Date.now().toString(36).toUpperCase()}`);
  await dialog.getByLabel(/value/i).first().fill(plaintext);
  await dialog.getByRole('button', { name: /create|save/i }).click();

  await expect(page.getByText(plaintext)).toHaveCount(0);
  expect(page.url()).not.toContain(plaintext);
});
