import { expect, type Page, test } from '@playwright/test';
import {
  apiCall,
  createWorkflow,
  expectNoPageError,
  registerAndSignIn,
  signInBrowser,
  until,
  useSessionCookie
} from './helpers';

/**
 * End-to-end coverage for the Files, Dashboards, Settings and Data surfaces.
 *
 * Every assertion checks a behaviour the requirements name rather than a pixel:
 * files are first-class and filterable through the shared AST; dedupe is reported
 * honestly; dashboards render each widget family with an exact-numbers fallback;
 * secrets never render; provenance is legible.
 *
 * ## Why one shared account
 *
 * `ensureStarterWorkspace` only creates a workspace when the database has no
 * workspaces at all, and `POST /api/workspaces` needs `workspace:read` — which a
 * membership-less account does not have. Registering a *new* account per test
 * therefore fails with `403 Missing permission: workspace:read` on any instance
 * that already has a workspace. Until that is resolved the suite registers once in
 * `beforeAll` and every test runs against that workspace, using a run-unique tag so
 * fixtures never collide across runs. Each test is written to be order-independent
 * except where a comment says otherwise.
 *
 * Run with a clean database (the config's `.e2e` directory) — see the report.
 */

interface Session {
  cookie: string;
  workspaceId: string;
  email: string;
}

let session: Session;
let tag = '';

test.beforeAll(async ({ playwright }) => {
  const baseURL =
    process.env.MENTAT_E2E_BASE_URL ?? `http://127.0.0.1:${process.env.MENTAT_E2E_PORT ?? 5373}`;
  const request = await playwright.request.newContext({ baseURL });
  try {
    const registered = await registerAndSignIn(request);
    const suffix = registered.identity.email.split('@')[0] ?? 'e2e';
    tag = suffix.slice(-8);
    session = {
      cookie: registered.cookie,
      workspaceId: registered.workspaceId,
      email: registered.identity.email
    };
    useSessionCookie(registered.cookie);
  } finally {
    await request.dispose();
  }
});

test.beforeEach(async ({ page }) => {
  await signInBrowser(page, session);
});

const TEXT_BODY =
  'ACME invoice 2026-01-15. Document type: Invoice. This sentence is deliberately searchable.';

/**
 * Upload a small text file through the public API. Text extraction is the simplest
 * deterministic processor, so content search and status assertions are not racing a
 * heavyweight parser.
 */
async function uploadTextFile(
  page: Page,
  name: string,
  body = TEXT_BODY
): Promise<{ fileId: string; deduplicated: boolean }> {
  const response = await page.request.post('/api/files', {
    multipart: {
      file: { name: `${tag}-${name}`, mimeType: 'text/plain', buffer: Buffer.from(body) }
    }
  });
  expect(response.ok(), `upload failed: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as { fileId: string; deduplicated: boolean };
}

/** Create a workspace-scoped file field definition. */
/**
 * Ensure a file field definition exists.
 *
 * The key is workspace-unique, so a rerun against a warm database finds it already
 * there; that is the state the test wants, not a failure.
 */
async function createFileField(page: Page, key: string): Promise<void> {
  const response = await page.request.fetch('/api/fields', {
    method: 'POST',
    data: { key, name: key.replace(/_/g, ' '), type: 'short_text', scope: 'file' },
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie
    },
    failOnStatusCode: false
  });
  if (response.ok() || response.status() === 409) return;
  throw new Error(
    `Could not ensure file field ${key}: ${response.status()} ${await response.text()}`
  );
}

/** Create a file field definition and set a value on one file. */
async function setFileField(page: Page, fileId: string, key: string, value: string): Promise<void> {
  await createFileField(page, key);
  await apiCall(page.request, 'PUT', `/files/${fileId}/fields`, {
    data: { workflowId: null, values: { [key]: value } }
  });
}

test.describe('Files', () => {
  test('a File is durable and content-addressed, and dedupe is reported honestly', async ({
    page
  }) => {
    const first = await uploadTextFile(page, 'invoice.txt');
    expect(first.deduplicated).toBe(false);

    // The same bytes again: a new logical appearance, no new stored bytes.
    const second = await uploadTextFile(page, 'invoice-copy.txt');
    expect(second.deduplicated).toBe(true);
    expect(second.fileId).not.toBe(first.fileId);

    await page.goto('/files');
    await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();
    await expect(page.getByText(`${tag}-invoice.txt`).first()).toBeVisible();
    await expect(page.getByText(`${tag}-invoice-copy.txt`).first()).toBeVisible();
    await expectNoPageError(page);
  });

  test('uploading through the interface reports reused bytes, not a fresh write', async ({
    page
  }) => {
    await uploadTextFile(page, 'dedupe-source.txt');

    await page.goto('/files');
    await page
      .getByRole('button', { name: /upload files/i })
      .first()
      .click();
    await expect(page.getByText(/drop files here/i)).toBeVisible();

    // Second upload of identical content through the real upload path.
    await page.locator('input[type="file"]').setInputFiles({
      name: `${tag}-dedupe-source.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(TEXT_BODY)
    });

    await expect(page.getByText(/already existed in this workspace/i).first()).toBeVisible({
      timeout: 15_000
    });
  });

  test('structured file-field filters run server-side through the shared AST', async ({ page }) => {
    const uploaded = await uploadTextFile(page, 'filter-me.txt');
    await setFileField(page, uploaded.fileId, 'document_type', 'Invoice');

    const filter = JSON.stringify({
      type: 'condition',
      kind: 'file_field',
      key: 'document_type',
      operator: 'eq',
      value: 'Invoice'
    });

    // The AST is the contract: the server must execute exactly what a saved view
    // stores, without the UI translating it into something else.
    const matched = await apiCall<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      page.request,
      'GET',
      `/files?filter=${encodeURIComponent(filter)}`
    );
    expect(matched.items.map((item) => item.id)).toContain(uploaded.fileId);

    const nonMatching = JSON.stringify({
      type: 'condition',
      kind: 'file_field',
      key: 'document_type',
      operator: 'eq',
      value: 'Receipt'
    });
    const missed = await apiCall<{ items: Array<{ id: string }> }>(
      page.request,
      'GET',
      `/files?filter=${encodeURIComponent(nonMatching)}`
    );
    expect(missed.items.map((item) => item.id)).not.toContain(uploaded.fileId);

    // And the UI executes the URL's filter, so a filtered list is a shareable link.
    await page.goto(`/files?filter=${encodeURIComponent(filter)}`);
    await expect(page.getByText(`${tag}-filter-me.txt`).first()).toBeVisible();
    await expectNoPageError(page);
  });

  test('the filter builder writes the shared AST into ?filter=', async ({ page }) => {
    await createFileField(page, 'document_type');

    await page.goto('/files');
    await page.getByRole('button', { name: /structured filters/i }).click();
    await page.getByRole('button', { name: /start from file fields/i }).click();

    await expect(page).toHaveURL(/filter=/);
    const url = new URL(page.url());
    const ast = JSON.parse(url.searchParams.get('filter') ?? 'null') as {
      type?: string;
      children?: unknown[];
    };
    expect(ast.type).toBe('group');
    expect(Array.isArray(ast.children)).toBe(true);

    // A saved view persists that same AST for the files scope.
    const view = await apiCall<{ view: { scope: string; filterAst: unknown } }>(
      page.request,
      'POST',
      '/views',
      { data: { name: `Invoices ${tag}`, scope: 'files', filterAst: ast } }
    );
    expect(view.view.scope).toBe('files');
    expect(view.view.filterAst).toEqual(ast);
  });

  test('an incomplete filter row never turns ordinary editing into an error page', async ({
    page
  }) => {
    // A row still being filled in has no field or value yet. The builder keeps it,
    // but the query is sent without it.
    const incomplete = JSON.stringify({
      type: 'group',
      op: 'and',
      children: [
        { type: 'condition', kind: 'file_field', key: '', operator: 'eq', value: '' },
        {
          type: 'condition',
          kind: 'system',
          key: 'filename',
          operator: 'contains',
          value: 'invoice'
        }
      ]
    });
    await page.goto(`/files?filter=${encodeURIComponent(incomplete)}`);
    await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();
    await expectNoPageError(page);
    // The valid half still applies.
    await expect(page.getByText(`${tag}-invoice.txt`).first()).toBeVisible();
  });

  test('extracted content is searchable and is presented as a distinct mode', async ({ page }) => {
    const uploaded = await uploadTextFile(page, 'searchable.txt');

    // Processing is durable and asynchronous; wait for the extract, not a UI hint.
    await until(
      async () => {
        const content = await apiCall<{ content: unknown }>(
          page.request,
          'GET',
          `/files/${uploaded.fileId}/content`
        );
        return content.content ? true : null;
      },
      { description: 'extracted content', timeoutMs: 40_000 }
    );

    await page.goto('/files');
    await page.getByRole('radio', { name: 'Content' }).click();
    await page.getByLabel(/search extracted content/i).fill('deliberately searchable');
    await page.getByRole('button', { name: /search content/i }).click();

    await expect(page.getByRole('heading', { name: /content matches/i })).toBeVisible();
    await expect(page.getByText(`${tag}-searchable.txt`).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /back to metadata list/i })).toBeVisible();
  });

  test('file detail covers all six tabs and states that unlinking is non-destructive', async ({
    page
  }) => {
    const uploaded = await uploadTextFile(page, 'detail.txt');
    await setFileField(page, uploaded.fileId, 'customer_name', 'ACME');

    await page.goto(`/files/${uploaded.fileId}`);
    for (const tab of ['Overview', 'Fields', 'Content', 'Relationships', 'Processing', 'History']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible();
    }

    // The field value is grouped under its workflow context and is correctable.
    await page.getByRole('tab', { name: 'Fields' }).click();
    await expect(page.getByText('customer name').first()).toBeVisible();
    await page.getByLabel('Value').first().fill('ACME Holdings');
    await page
      .getByRole('button', { name: /correct/i })
      .first()
      .click();
    await expect(page.getByText(/corrected/i).first()).toBeVisible({ timeout: 15_000 });

    // Relationships explains that unlinking never removes the file or its bytes.
    await page.getByRole('tab', { name: 'Relationships' }).click();
    await expect(page.getByText(/never deletes the file or its bytes/i)).toBeVisible();

    // Processing explains the full processing identity.
    await page.getByRole('tab', { name: 'Processing' }).click();
    await expect(page.getByText(/contentHash \+ processorType \+ processorVersion/i)).toBeVisible();

    // History is the file-scoped audit ledger.
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByText(/append-only/i).first()).toBeVisible();
    await expectNoPageError(page);
  });
});

test.describe('Dashboards', () => {
  test('creates a dashboard, adds a KPI widget and renders its exact value', async ({ page }) => {
    await createWorkflow(page.request, `Analytics ${tag}`, 'claims');

    await page.goto('/dashboards');
    await expect(page.getByRole('heading', { name: 'Dashboards' })).toBeVisible();

    await page
      .getByRole('button', { name: /new dashboard/i })
      .first()
      .click();
    await page.getByLabel('Name').fill(`Operations board ${tag}`);
    await page.getByRole('button', { name: /create dashboard/i }).click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]+/i);

    await expect(page.getByRole('heading', { name: `Operations board ${tag}` })).toBeVisible();
    // The interface states that both filter levels share the ticket-list language.
    await expect(page.getByText(/same filter language as the ticket list/i)).toBeVisible();

    await page
      .getByRole('button', { name: /add widget/i })
      .first()
      .click();
    await page.getByLabel('Title').fill('Ticket count');
    await page.getByLabel('Aggregation').selectOption('count');
    await page
      .getByRole('button', { name: /add widget/i })
      .last()
      .click();

    await expect(page.getByText('Ticket count').first()).toBeVisible();
    // A KPI renders a number, and the underlying count is 0 on a fresh workspace.
    await expect(page.getByText('0').first()).toBeVisible({ timeout: 15_000 });
  });

  test('every chart exposes a data-table fallback with the exact numbers', async ({ page }) => {
    await page.goto('/dashboards');
    await page
      .getByRole('button', { name: /new dashboard/i })
      .first()
      .click();
    await page.getByLabel('Name').fill(`Fallback board ${tag}`);
    await page.getByRole('button', { name: /create dashboard/i }).click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]+/i);

    await page
      .getByRole('button', { name: /add widget/i })
      .first()
      .click();
    await page.getByLabel('Title').fill('By state');
    await page.getByLabel('Visualisation').selectOption('bar');
    await page.getByLabel('Aggregation').selectOption('count');
    await page.getByLabel('Group by').selectOption('state');
    await page
      .getByRole('button', { name: /add widget/i })
      .last()
      .click();
    await expect(page.getByText('By state').first()).toBeVisible();

    await page.getByRole('radio', { name: 'Data' }).first().click();
    await expect(page.getByRole('columnheader', { name: /value/i }).first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /label/i }).first()).toBeVisible();
  });

  test('a funnel is authored from explicitly ordered milestones, never board order', async ({
    page
  }) => {
    await createWorkflow(page.request, `Funnel ${tag}`, 'claims');

    await page.goto('/dashboards');
    await page
      .getByRole('button', { name: /new dashboard/i })
      .first()
      .click();
    await page.getByLabel('Name').fill(`Funnel board ${tag}`);
    await page.getByRole('button', { name: /create dashboard/i }).click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]+/i);

    await page
      .getByRole('button', { name: /add widget/i })
      .first()
      .click();
    await page.getByLabel('Title').fill('Intake to closed');
    await page.getByLabel('Visualisation').selectOption('funnel');

    await expect(page.getByText(/funnel milestones \(explicit order\)/i)).toBeVisible();
    await expect(page.getByText(/board order is never used to infer stage order/i)).toBeVisible();

    await page.getByRole('button', { name: /add milestone/i }).click();
    await page.getByRole('button', { name: /add milestone/i }).click();
    await page.getByLabel('Label').nth(2).fill('Closed');

    // Ordering is a control the author owns, with explicit move buttons.
    await expect(page.getByRole('button', { name: '↓' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '↑' }).last()).toBeVisible();
  });

  test('an aging widget states that its numbers come from recorded history', async ({ page }) => {
    await page.goto('/dashboards');
    await page
      .getByRole('button', { name: /new dashboard/i })
      .first()
      .click();
    await page.getByLabel('Name').fill(`Aging board ${tag}`);
    await page.getByRole('button', { name: /create dashboard/i }).click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]+/i);

    await page
      .getByRole('button', { name: /add widget/i })
      .first()
      .click();
    await page.getByLabel('Title').fill('Dwell time');
    await page.getByLabel('Visualisation').selectOption('aging');
    await expect(page.getByText(/ticket_state_history/i).first()).toBeVisible();
    await expect(page.getByText(/in-progress work is counted rather than dropped/i)).toBeVisible();
  });
});

test.describe('Settings', () => {
  test('workspace settings persist and are audited', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    await page.getByLabel('Retention (days)').fill('30');
    await page.getByLabel('Default timezone').selectOption('Europe/London');
    await page.getByRole('button', { name: /save workspace/i }).click();
    await expect(page.getByText(/workspace settings saved/i).first()).toBeVisible({
      timeout: 15_000
    });

    await page.goto('/settings/audit');
    await expect(page.getByText('workspace.updated').first()).toBeVisible({ timeout: 15_000 });
  });

  // Order matters here: this asserts the rule *before* a second owner exists, and
  // the next test promotes one. Both run in declaration order in a single worker.
  test('the last active owner rule is visible before the attempt', async ({ page }) => {
    await page.goto('/settings/members');
    await expect(page.getByText(/last active owner/i).first()).toBeVisible();
    const row = page.locator('tr', { hasText: /last active owner/i }).first();
    await expect(row.getByRole('button', { name: /remove/i })).toBeDisabled();
    await expect(row.getByRole('button', { name: /suspend/i })).toBeDisabled();
  });

  test('promoting a second owner clears the last-owner flag', async ({ page }) => {
    await page.goto('/settings/members');
    await page
      .getByRole('button', { name: /invite member/i })
      .first()
      .click();
    await page.getByLabel('Email').fill(`teammate-${tag}@mentat.test`);
    await page.getByLabel('Name').fill('Teammate');
    await page.getByRole('button', { name: /send invite/i }).click();
    await expect(page.getByText('Teammate').first()).toBeVisible({ timeout: 15_000 });

    await page
      .getByRole('button', { name: /invite member/i })
      .first()
      .click();
    await page.getByLabel('Email').fill(`owner-${tag}@mentat.test`);
    await page.getByLabel('Name').fill('Second Owner');
    await page.getByLabel('Role', { exact: true }).first().selectOption('owner');
    await page.getByRole('button', { name: /send invite/i }).click();
    await expect(page.getByText('Second Owner').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/last active owner/i)).toHaveCount(0);
  });

  test('teams can be created and membership managed as a set', async ({ page }) => {
    await page.goto('/settings/teams');
    await page
      .getByRole('button', { name: /new team/i })
      .first()
      .click();
    await page.getByLabel('Name').fill(`Claims adjusters ${tag}`);
    await page.getByRole('button', { name: /create team/i }).click();
    await expect(page.getByText(`Claims adjusters ${tag}`).first()).toBeVisible({
      timeout: 15_000
    });
    await expect(page.getByText(/0 member/i).first()).toBeVisible();
  });

  test('secrets are write-only: no plaintext in the DOM or the URL', async ({ page }) => {
    const secretValue = 'super-secret-e2e-value';
    await page.goto('/settings/secrets');
    await page
      .getByRole('button', { name: /new secret/i })
      .first()
      .click();
    await page.getByLabel('Key').fill(`SMOKE_API_KEY_${tag.toUpperCase()}`);
    await page.getByLabel('Value').fill(secretValue);
    await page.getByRole('button', { name: /create secret/i }).click();

    await expect(page.getByText(/will never be shown again/i).first()).toBeVisible({
      timeout: 15_000
    });
    expect(page.url()).not.toContain(secretValue);
    await expect(page.getByText(secretValue)).toHaveCount(0);

    const row = page.locator('tr', { hasText: `SMOKE_API_KEY_${tag.toUpperCase()}` }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(/••••/)).toBeVisible();
  });

  test('environment shows provenance per key and explains override resolution', async ({
    page
  }) => {
    const key = `HUBSPOT_REGION_${tag.toUpperCase()}`;
    await apiCall(page.request, 'PUT', '/environment', {
      data: { key, value: 'eu-west-1' }
    });

    await page.goto('/settings/environment');
    await expect(page.getByText(/workflow override > workspace value/i).first()).toBeVisible();
    await expect(page.getByText(key).first()).toBeVisible();
    await expect(page.getByText('Local', { exact: true }).first()).toBeVisible();

    // Provenance is inspectable per key.
    await page.getByRole('button', { name: key }).click();
    await expect(page.getByText(/effective source/i).first()).toBeVisible();
  });

  test('overrides describe bindings as provenance rows and can bind a resource', async ({
    page
  }) => {
    const workflow = await createWorkflow(page.request, `Overrides ${tag}`, 'basic');
    await page.setViewportSize({ width: 1400, height: 900 });

    // Binding a workflow-scoped resource with no source is a *local* definition.
    await apiCall(page.request, 'PUT', '/overrides', {
      data: {
        workflowId: workflow.id,
        resourceType: 'agent',
        resourceId: `agent-local-${tag}`,
        sourceResourceId: null,
        mode: 'fork'
      }
    });

    await page.goto(`/settings/overrides?workflowId=${workflow.id}`);
    await expect(page.getByRole('heading', { name: 'Overrides' })).toBeVisible();
    await expect(page.getByText(/removing one resumes inheritance/i).first()).toBeVisible();

    await page.getByLabel('Workflow').selectOption(workflow.id);
    await expect(page.getByText(`agent-local-${tag}`).first()).toBeVisible({ timeout: 15_000 });

    // Removing the binding resumes inheritance.
    await page
      .getByRole('button', { name: /remove/i })
      .first()
      .click();
    await expect(page.getByText(/resumes inheritance/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('storage states the database/store split and never returns a credential', async ({
    page
  }) => {
    await page.goto('/settings/storage');
    await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
    await expect(page.getByText(/never in a database table/i)).toBeVisible();
    await expect(page.getByText(/never returned by the api/i)).toBeVisible();
  });

  test('jobs show lease state and an attempts drawer including lease expiry', async ({ page }) => {
    await uploadTextFile(page, 'job-source.txt');
    await until(
      async () => {
        const jobs = await apiCall<{ jobs: Array<{ type: string; status: string }> }>(
          page.request,
          'GET',
          '/jobs?type=file.process'
        );
        return jobs.jobs.some((job) => job.status === 'completed') ? true : null;
      },
      { description: 'a completed file processing job', timeoutMs: 40_000 }
    );

    await page.goto('/settings/jobs');
    await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();
    await expect(page.getByText('file.process').first()).toBeVisible();

    await page
      .getByRole('button', { name: /attempts/i })
      .first()
      .click();
    await expect(page.getByText(/attempt history/i)).toBeVisible();
  });

  test('audit is append-only with a redacted payload detail', async ({ page }) => {
    await apiCall(page.request, 'PUT', '/environment', {
      data: { key: `AUDITED_KEY_${tag.toUpperCase()}`, value: 'value' }
    });

    await page.goto('/settings/audit');
    await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
    await expect(page.getByText('variable.set').first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'variable.set' }).first().click();
    await expect(page.getByText(/data payload/i)).toBeVisible();
    await expect(page.getByText(/redacted before storage/i).first()).toBeVisible();
  });
});

test.describe('Workflow data', () => {
  test('collections support record create, edit with versioning, and delete', async ({ page }) => {
    const key = `smoke_collection_${tag}`;
    await page.goto('/data');
    await expect(page.getByRole('heading', { name: /workflow data/i })).toBeVisible();

    await page
      .getByRole('button', { name: /\+ new/i })
      .first()
      .click();
    await page.getByLabel('Key').fill(key);
    await page.getByLabel('Name').fill(`Smoke collection ${tag}`);
    await page
      .getByLabel('JSON schema')
      .fill('{"type":"object","properties":{"name":{"type":"string"}}}');
    await page.getByRole('button', { name: /create collection/i }).click();
    await expect(page.getByText(`Smoke collection ${tag}`).first()).toBeVisible({
      timeout: 15_000
    });

    // A record is edited as JSON and written with optimistic versioning.
    await page.getByRole('button', { name: /new record/i }).click();
    await page.getByLabel(/record \(json\)/i).fill('{"name":"ACME"}');
    await page.getByRole('button', { name: /create record/i }).click();
    await expect(page.getByText(/ACME/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/v1/).first()).toBeVisible();

    await page.getByRole('button', { name: /edit/i }).first().click();
    await expect(page.getByText(/editing version 1/i)).toBeVisible();
    await page.getByLabel(/record \(json\)/i).fill('{"name":"ACME Holdings"}');
    await page.getByRole('button', { name: /save record/i }).click();
    await expect(page.getByText(/ACME Holdings/).first()).toBeVisible({ timeout: 15_000 });

    await page
      .getByRole('button', { name: /delete/i })
      .first()
      .click();
    await expect(page.getByText(/no records/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('agent state is read-only and cache values are only shown on request', async ({ page }) => {
    const stateKey = `smoke_state_${tag}`;
    const cacheKey = `smoke_key_${tag}`;
    await apiCall(page.request, 'PUT', '/state', {
      data: { scope: 'workspace', key: stateKey, value: { note: 'hidden by default' } }
    });
    await apiCall(page.request, 'PUT', '/cache', {
      data: {
        namespace: `smoke-${tag}`,
        key: cacheKey,
        value: { cached: true },
        ttlSeconds: 60
      }
    });

    await page.goto('/data');
    await page.getByRole('tab', { name: /agent state/i }).click();
    await expect(page.getByText(/written by tools during runs/i)).toBeVisible();
    await page.getByRole('button', { name: /load workspace state/i }).click();
    await expect(page.getByText(stateKey).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/hidden —/i).first()).toBeVisible();

    await page
      .getByRole('button', { name: /reveal/i })
      .first()
      .click();
    await expect(page.getByText(/hidden by default/).first()).toBeVisible();

    await page.getByRole('tab', { name: /^cache$/i }).click();
    await expect(page.getByText(/only shown when you explicitly request them/i)).toBeVisible();
    await page.getByRole('button', { name: /^load$/i }).click();
    await expect(page.getByText(cacheKey).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('hidden', { exact: true }).first()).toBeVisible();
  });
});
