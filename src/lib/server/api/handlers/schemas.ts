/**
 * Schema authoring API.
 *
 * One stateless endpoint compiles Zod source and parses a JSON sample against it,
 * returning both the result and the field projection it would create. Object Type,
 * workflow overlay and workflow state editors share it, so "test before saving"
 * runs the exact evaluator the engine later runs — not a client-side approximation.
 */
import { z } from 'zod';
import { Permissions } from '../../core/context';
import { testZodSource } from '../../schemas/zod-source';
import { route } from '../types';

export const schemaRoutes = [
  route({
    method: 'POST',
    path: '/schemas/test',
    permission: Permissions.workflowAdmin,
    summary: 'Compile a Zod schema source and test it against a JSON sample',
    body: z.object({
      source: z.string().min(1).max(20_000),
      sample: z.unknown().optional()
    }),
    handler: ({ body }) => ({ body: testZodSource(body.source, body.sample ?? {}) })
  })
];
