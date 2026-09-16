/** Landing: send the user to their work surface. */
import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ parent }) => {
  const layout = await parent();
  if (!layout.workspace) throw redirect(303, '/login');
  throw redirect(303, '/workflows');
};
