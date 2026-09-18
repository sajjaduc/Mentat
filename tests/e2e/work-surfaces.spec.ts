/**
 * End-to-end coverage for the core work surfaces.
 *
 * The spec seeds its own workflow and tickets through the real API and signs the
 * browser in with the shared helpers, so it exercises the product rather than its
 * own fixtures. It assumes `playwright.config.ts` provides `baseURL` and the
 * `.e2e` database; it does not start a server of its own.
 */
import { type APIRequestContext, expect, test } from '@playwright/test';
import {
  apiCall,
  createObjectType,
  createWorkflow,
  createWorkItem,
  DEMO_PASSWORD,
  gotoApp,
  registerAndSignIn,
  signInBrowser,
  useSessionCookie
} from './helpers';

/**
 * A fixed account, not a generated one: the first registration on a fresh database
 * owns its workspace, and every later worker or rerun signs in as that same account
 * so the fixtures it created are still there.
 */
const account = {
  email: 'work-surfaces-e2e@mentat.test',
  name: 'Work Surfaces E2E',
  password: DEMO_PASSWORD,
  workspaceName: 'Work Surfaces'
};
let session: { cookie: string; workspaceId: string } | null = null;

/**
 * One account per worker. A warm `.e2e` database already contains the account, so
 * fall back to signing in rather than registering again.
 */
async function ensureSession(request: APIRequestContext) {
  if (session) {
    // The API call helper is per-file state; keep it pointing at this session even
    // when the cookie came from a previous test.
    useSessionCookie(session.cookie);
    return session;
  }
  const registered = await registerAndSignIn(request, account).catch(async () => {
    const response = await request.post('/api/auth/login', {
      data: { email: account.email, password: account.password },
      failOnStatusCode: false
    });
    expect(response.ok(), 'the e2e account could neither register nor sign in').toBeTruthy();
    const body = (await response.json()) as { workspaces?: Array<{ workspaceId: string }> };
    const workspaceId = body.workspaces?.[0]?.workspaceId;
    expect(
      workspaceId,
      'the e2e account has no workspace; delete .e2e/mentat-e2e.db and rerun'
    ).toBeTruthy();
    const setCookie = response.headers()['set-cookie'] ?? '';
    const cookie = setCookie.split(';')[0] ?? '';
    useSessionCookie(cookie);
    return { identity: account, cookie, workspaceId: workspaceId as string };
  });
  session = { cookie: registered.cookie, workspaceId: registered.workspaceId };
  return session;
}

test.beforeEach(async ({ page, request }) => {
  const current = await ensureSession(request);
  await signInBrowser(page, current);
});

interface SeededWorkflow {
  id: string;
  name: string;
  objectTypeId: string;
  states: Array<{ id: string; name: string }>;
  items: Array<{ id: string; recordId: string; key: string; title: string }>;
}

async function seed(request: APIRequestContext, itemTitles: string[]): Promise<SeededWorkflow> {
  const name = `Board ${Math.random().toString(36).slice(2, 7)}`;
  const workflow = await createWorkflow(request, name, 'basic');
  const first = workflow.states[0];
  expect(first, 'the basic template creates states').toBeTruthy();

  const items: SeededWorkflow['items'] = [];
  for (const title of itemTitles) {
    const item = await createWorkItem(request, {
      workflowId: workflow.id,
      title,
      stateId: first?.id
    });
    items.push({ id: item.id, recordId: item.recordId, key: item.key, title });
  }
  return {
    id: workflow.id,
    name,
    objectTypeId: workflow.objectTypeId,
    states: workflow.states,
    items
  };
}

test.describe('workflow surfaces', () => {
  test('index lists workflows with counts and creates one from a template', async ({
    page,
    request
  }) => {
    const seeded = await seed(request, []);
    // A workflow must name the Object Type it processes (ADR-0021). Create it before
    // the page loads so the dialog's Object Type picker includes it.
    const createdName = `UI Created ${Math.random().toString(36).slice(2, 6)}`;
    const dialogType = await createObjectType(request, `UI Dialog ${createdName}`);

    await gotoApp(page, '/workflows');
    const card = page.getByTestId('workflow-card').filter({ hasText: seeded.name });
    await expect(card).toBeVisible();
    // The count noun comes from the workflow's Object Type plural name; it falls back
    // to "items" when the list payload omits it.
    await expect(card).toContainText(/0 (items|objects)/);
    await expect(card).toContainText('states');

    await page.getByRole('button', { name: 'Create workflow' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Blank')).toBeVisible();
    await expect(dialog.getByText('Intake')).toBeVisible();

    await dialog.getByLabel('Name').fill(createdName);
    await dialog.getByLabel('Object Type (required)').selectOption(dialogType.id);
    await dialog.getByRole('button', { name: 'Create and open board' }).click();

    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]+\?tab=board/);
    await expect(page.getByTestId('board-column').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: createdName })).toBeVisible();
  });

  test('board renders columns in order, filters, and creates a card inline', async ({
    page,
    request
  }) => {
    const seeded = await seed(request, ['Alpha ticket', 'Beta ticket']);

    await gotoApp(page, `/workflows/${seeded.id}?tab=board`);
    const columns = page.getByTestId('board-column');
    await expect(columns.first()).toBeVisible();
    await expect(columns.nth(0)).toContainText(seeded.states[0]?.name ?? '');
    await expect(columns.nth(1)).toContainText(seeded.states[1]?.name ?? '');
    const firstColumn = columns.nth(0);
    await expect(firstColumn.getByText('Alpha ticket')).toBeVisible();
    await expect(firstColumn.getByText('Beta ticket')).toBeVisible();

    await firstColumn.getByRole('button', { name: /^Add .+ to / }).click();
    await page.getByLabel('New item title').fill('Gamma ticket');
    await firstColumn.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(firstColumn.getByText('Gamma ticket')).toBeVisible();
  });

  test('board search narrows the visible cards', async ({ page, request }) => {
    const seeded = await seed(request, ['Alpha ticket', 'Beta ticket']);

    await gotoApp(page, `/workflows/${seeded.id}?tab=board`);
    const firstColumn = page.getByTestId('board-column').nth(0);
    await expect(firstColumn.getByText('Alpha ticket')).toBeVisible();
    await expect(firstColumn.getByText('Beta ticket')).toBeVisible();

    await page.getByLabel('Search work items').fill('Alpha');
    await expect(firstColumn.getByText('Alpha ticket')).toBeVisible();
    // The board filter is the shared filter AST, so searching narrows the cards.
    await expect(firstColumn.getByText('Beta ticket')).toHaveCount(0);
    await page.getByRole('button', { name: /^Clear/ }).click();
    await expect(firstColumn.getByText('Beta ticket')).toBeVisible();
  });

  test('a card moves between columns from the keyboard-accessible menu', async ({
    page,
    request
  }) => {
    const seeded = await seed(request, ['Movable ticket']);

    await gotoApp(page, `/workflows/${seeded.id}?tab=board`);
    const card = page.getByTestId('board-card').filter({ hasText: 'Movable ticket' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Card actions' }).click();
    // The move actions are menu items, which is what makes them announced as a menu.
    await card.getByRole('menuitem', { name: 'Start' }).click();

    await expect(page.getByTestId('board-column').nth(1).getByText('Movable ticket')).toBeVisible();
  });

  test('a card can be dragged between columns', async ({ page, request }) => {
    const seeded = await seed(request, ['Draggable ticket']);

    await gotoApp(page, `/workflows/${seeded.id}?tab=board`);
    const card = page.getByTestId('board-card').filter({ hasText: 'Draggable ticket' });
    await expect(
      page.getByTestId('board-column').nth(0).getByText('Draggable ticket')
    ).toBeVisible();
    await card.dragTo(page.getByTestId('board-column').nth(1));

    await expect(
      page.getByTestId('board-column').nth(1).getByText('Draggable ticket')
    ).toBeVisible();
  });

  test('work item drawer is URL-addressed, edits inline, and closes without navigating', async ({
    page,
    request
  }) => {
    const seeded = await seed(request, ['Drawer ticket']);
    const item = seeded.items[0];

    await gotoApp(page, `/workflows/${seeded.id}?tab=board&workItem=${item?.id}`);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(item?.key ?? '')).toBeVisible();

    const title = drawer.getByLabel('Work item title');
    await title.fill('Drawer ticket renamed');
    await title.blur();
    await page.reload();
    await expect(page.getByRole('dialog').getByLabel('Work item title')).toHaveValue(
      'Drawer ticket renamed'
    );

    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page).not.toHaveURL(/workItem=/);
    await expect(page.getByTestId('board-card').first()).toBeVisible();
  });

  test('drawer tabs expose Agent Work, Activity and Artifacts states', async ({
    page,
    request
  }) => {
    const seeded = await seed(request, ['Tabs ticket']);
    const item = seeded.items[0];

    await gotoApp(page, `/workflows/${seeded.id}?tab=board&workItem=${item?.id}`);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();

    await drawer.getByRole('tab', { name: 'Agent Work' }).click();
    await expect(drawer.getByTestId('agent-work-tab')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Run now' }).first()).toBeVisible();

    await drawer.getByRole('tab', { name: 'Activity' }).click();
    await expect(drawer.getByTestId('activity-tab')).toBeVisible();

    await drawer.getByRole('tab', { name: 'Artifacts' }).click();
    await expect(drawer.getByTestId('artifacts-tab')).toBeVisible();
  });

  test('workflow tab selection lives in the URL and survives a reload', async ({
    page,
    request
  }) => {
    const seeded = await seed(request, ['Listed ticket']);

    await gotoApp(page, `/workflows/${seeded.id}?tab=board`);
    await page.getByRole('tab', { name: 'List' }).click();
    await expect(page).toHaveURL(/tab=list/);
    await expect(page.getByRole('table')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Listed ticket' })).toBeVisible();

    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.getByTestId('workflow-data')).toBeVisible();

    await page.getByRole('tab', { name: 'Configuration' }).click();
    await expect(page.getByTestId('state-designer')).toBeVisible();
  });

  test('configuration can rename a state', async ({ page, request }) => {
    const seeded = await seed(request, []);
    const first = seeded.states[0];
    expect(first).toBeTruthy();

    await gotoApp(page, `/workflows/${seeded.id}?tab=configuration`);
    const designer = page.getByTestId('state-designer');
    await expect(designer).toBeVisible();

    // States render in board order, and the designer lists them in that order, so the
    // first Edit button belongs to the first state. It can sit under the sticky page
    // header, so scroll it into view first, exactly as a person would.
    const editButton = designer.getByRole('button', { name: 'Edit' }).first();
    await editButton.scrollIntoViewIfNeeded();
    await editButton.click();
    const dialog = page.getByRole('dialog');
    const renamed = `${first?.name} reviewed`;
    await dialog.getByLabel('Name').fill(renamed);
    await dialog.getByRole('button', { name: 'Save state' }).click();
    await expect(designer.getByText(renamed, { exact: true })).toBeVisible();
  });

  test('list columns can be toggled from the column picker', async ({ page, request }) => {
    const seeded = await seed(request, ['Column ticket']);

    await gotoApp(page, `/workflows/${seeded.id}?tab=list`);
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Priority' })).toBeVisible();

    await page.getByRole('button', { name: /Columns/ }).click();
    await page.getByRole('checkbox', { name: 'Priority' }).click();
    await expect(page.getByRole('columnheader', { name: 'Priority' })).toHaveCount(0);
  });

  test('my work buckets render counts and open the work item drawer', async ({ page, request }) => {
    await seed(request, ['My work ticket']);

    await gotoApp(page, '/my-work');
    await expect(page.getByRole('heading', { name: 'My Work', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /Waiting for me/ }).click();
    const row = page.getByRole('row').filter({ hasText: 'My work ticket' }).first();
    await expect(row).toBeVisible();

    await row.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/workItem=/);
  });

  test('approvals inbox renders its status filters and empty state', async ({ page, request }) => {
    await apiCall(request, 'GET', '/my-work');

    await gotoApp(page, '/approvals');
    await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pending' })).toBeVisible();
    await page.getByRole('button', { name: 'All' }).click();
    await expect(page).toHaveURL(/status=all/);
    await expect(page.getByText('Select an approval')).toBeVisible();
  });
});
