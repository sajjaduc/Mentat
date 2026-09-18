/**
 * A freshly registered workspace is empty, and every surface has to say so.
 *
 * Registration provisions a workspace per account, so this is the state any
 * self-registered account starts in: no Object Types, no records. `/records` used to
 * spin on its skeleton forever here, because `loadRecords` returned early while
 * `loading` was still true and `loadTypes` never released it either. The bug was
 * invisible on the seeded workspace, which already had an Object Type.
 */
import { expect, test } from '@playwright/test';
import {
  expectNoPageError,
  gotoApp,
  identity,
  projectBaseUrl,
  signInBrowser
} from './helpers';

test('an account whose workspace has no Object Types gets an empty state, not a spinner', async ({
  page,
  playwright
}) => {
  const baseURL = projectBaseUrl();
  const request = await playwright.request.newContext({ baseURL });
  try {
    const account = identity('empty-workspace');
    const response = await request.post('/api/auth/register', {
      data: { email: account.email, name: account.name, password: account.password },
      failOnStatusCode: false
    });
    expect(response.status()).toBe(201);
    const registered = (await response.json()) as { workspaceId: string | null };
    // Registration must always hand back a workspace. Returning null was the other
    // half of this defect: the account could sign in but no API call would succeed.
    expect(registered.workspaceId).toBeTruthy();

    const cookie = (response.headers()['set-cookie'] ?? '').split(';')[0] ?? '';
    await signInBrowser(page, { cookie, workspaceId: registered.workspaceId as string });

    await gotoApp(page, '/records');
    await expect(page.getByText('No Object Types are defined yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New record' })).toBeDisabled();
    // The skeleton is the failure mode this guards: it used to stay forever.
    await expect(page.locator('.skeleton')).toHaveCount(0);
    await expectNoPageError(page);
  } finally {
    await request.dispose();
  }
});
