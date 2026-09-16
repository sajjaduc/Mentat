/**
 * Sign-in screen data.
 *
 * `needsSetup` is true when the instance has no accounts yet, which is what turns
 * the form into "create the first account" instead of requiring an out-of-band
 * bootstrap step.
 */

import { redirect } from '@sveltejs/kit';
import { ensureBootstrapped } from '$server/bootstrap';
import { allowSignup } from '$server/config/env';
import { getDb } from '$server/db/client';
import { users } from '$server/db/schema';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  await ensureBootstrapped();
  if (locals.userId && locals.workspaceId) {
    throw redirect(303, '/workflows');
  }
  const db = getDb();
  const anyUser = db.select({ id: users.id }).from(users).limit(1).all();
  return {
    needsSetup: anyUser.length === 0,
    signupDisabled: !allowSignup()
  };
};
