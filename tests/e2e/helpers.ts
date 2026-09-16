/**
 * E2E helpers.
 *
 * A browser test should exercise the product, not the login form. These helpers
 * create a workspace and a session through the real API, then hand the browser a
 * signed-in cookie — so each spec starts at the surface it is actually testing while
 * still proving that registration and sign-in work.
 *
 * Fixtures are namespaced per run so parallel or repeated runs never collide, and
 * the server always has a clean database (see `playwright.config.ts`).
 */
import { type APIRequestContext, expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'mentat-e2e-password';

export interface TestIdentity {
  email: string;
  name: string;
  password: string;
  workspaceName: string;
}

let counter = 0;

export function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

export function identity(label = 'e2e'): TestIdentity {
  const suffix = uniqueSuffix();
  return {
    email: `${label}-${suffix}@mentat.test`,
    name: `E2E ${label}`,
    password: DEMO_PASSWORD,
    workspaceName: `Workspace ${suffix}`
  };
}

export interface ApiEnvelope {
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * The session cookie the specs' API calls should carry.
 *
 * Playwright's `request` fixture is a fresh context per test, so a cookie held in a
 * spec-level variable is not automatically present on it. Rather than thread the
 * cookie through every call site, the session helpers register it here once and
 * `apiCall` sends it. `signInBrowser` still puts it in the browser.
 */
let sessionCookie: string | null = null;

export function useSessionCookie(cookie: string): void {
  sessionCookie = cookie;
}

/** Call the API, carrying the registered session cookie when there is one. */
export async function apiCall<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: { data?: unknown; cookie?: string } = {}
): Promise<T> {
  const cookie = options.cookie ?? sessionCookie;
  const headers: Record<string, string> = {};
  if (options.data !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;

  const response = await request.fetch(`/api${path}`, {
    method,
    data: options.data,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    failOnStatusCode: false
  });
  const text = await response.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as T & ApiEnvelope) : ({} as T & ApiEnvelope);
  if (!response.ok()) {
    throw new Error(
      `API ${method} ${path} failed (${response.status()}): ${parsed.error?.message ?? text}`
    );
  }
  return parsed;
}

/**
 * Register an account and return the session cookie plus a workspace.
 *
 * The first registration also creates a starter workspace, which is exactly what a
 * new local install does — so this helper doubles as a test of first-run setup.
 */
export async function registerAndSignIn(
  request: APIRequestContext,
  overrides: Partial<TestIdentity> = {}
): Promise<{ identity: TestIdentity; cookie: string; workspaceId: string }> {
  const id = { ...identity(), ...overrides };

  const response = await request.post('/api/auth/register', {
    data: { email: id.email, name: id.name, password: id.password },
    failOnStatusCode: false
  });
  if (!response.ok()) {
    const body = (await response.json()) as ApiEnvelope;
    throw new Error(`Registration failed: ${body.error?.message ?? response.status()}`);
  }

  const setCookie = response.headers()['set-cookie'] ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  useSessionCookie(cookie);
  const body = (await response.json()) as { workspaceId: string | null };

  // Registration only creates a starter workspace on an empty instance. A second
  // account (or a rerun against a warm database) must create its own, which a
  // signed-in user with no workspace is allowed to do.
  let workspaceId = body.workspaceId;
  if (!workspaceId) {
    const created = await apiCall<{ workspace: { id: string } }>(request, 'POST', '/workspaces', {
      data: { name: id.workspaceName }
    });
    workspaceId = created.workspace.id;
    // The route activates the new workspace for this session; assert it took effect
    // so a spec never runs against a workspace-less actor.
    await apiCall(request, 'POST', '/auth/switch-workspace', { data: { workspaceId } });
  }
  if (!workspaceId) {
    throw new Error('Registered account has no workspace and could not create one');
  }

  return { identity: id, cookie, workspaceId };
}

/** Put the session cookie into the browser so specs begin signed in. */
export async function signInBrowser(
  page: Page,
  session: { cookie: string; workspaceId: string }
): Promise<void> {
  const [name, value] = session.cookie.split('=');
  await page.context().addCookies([
    {
      name: name ?? 'mentat_session',
      value: value ?? '',
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax'
    }
  ]);
}

/** Sign in through the form (used by the auth spec, which must test the real path). */
export async function signInThroughForm(page: Page, id: TestIdentity): Promise<void> {
  await page.goto('/login');
  // The form is progressively enhanced, so wait for hydration before clicking:
  // a pre-hydration click submits natively and puts the password in the URL.
  await expect(page.locator('form[data-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Email').fill(id.email);
  await page.getByLabel('Password').fill(id.password);
  await page.getByRole('button', { name: /sign in|create account/i }).click();
  await expect(page).toHaveURL(/\/(workflows|my-work)/, { timeout: 20_000 });
}

/** Create a workflow through the API and return its id. */
export async function createWorkflow(
  request: APIRequestContext,
  name: string,
  template: 'blank' | 'basic' | 'intake' | 'claims' | 'support' = 'basic'
): Promise<{ id: string; states: Array<{ id: string; name: string }> }> {
  const created = await apiCall<{
    workflow: { id: string };
    states: Array<{ id: string; name: string }>;
  }>(request, 'POST', '/workflows', { data: { name, template } });
  return { id: created.workflow.id, states: created.states };
}

/** Create a ticket through the API and return its id. */
export async function createTicket(
  request: APIRequestContext,
  input: { workflowId: string; title: string; stateId?: string; fields?: Record<string, unknown> }
): Promise<{ id: string; key: string }> {
  const created = await apiCall<{ ticket: { id: string; key: string } }>(
    request,
    'POST',
    '/tickets',
    { data: input }
  );
  return created.ticket;
}

/**
 * Poll until a predicate holds. Used for the few genuinely asynchronous flows
 * (agent runs, file processing) where waiting on a UI signal would be racy.
 */
export async function until<T>(
  check: () => Promise<T | null> | T | null,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result !== null && result !== undefined && result !== false) return result;
      last = result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${options.description ?? 'condition'}. Last value: ${String(last)}`
  );
}

/** Assert that a page rendered at least one of its expected states, never a raw error. */
export async function expectNoPageError(page: Page): Promise<void> {
  await expect(page.locator('text=/something went wrong|unhandled/i')).toHaveCount(0);
}
