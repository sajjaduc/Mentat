/** Landing: send the user to their work surface. */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const layout = await parent();
  if (!layout.workspace) throw redirect(303, '/login');
  throw redirect(303, '/workflows');
};
