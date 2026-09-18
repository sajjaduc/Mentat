/**
 * The complete API surface.
 *
 * Handlers are grouped by domain; route order is irrelevant because matching is
 * exact on segment count and method. `publicWebhookRoutes` are listed last and are
 * the only routes reachable without a session.
 */

import { agentRoutes } from './handlers/agents';
import { authRoutes } from './handlers/auth';
import { dataRoutes } from './handlers/data';
import { httpRoutes, publicWebhookRoutes } from './handlers/http';
import { recordRoutes } from './handlers/records';
import { schemaRoutes } from './handlers/schemas';
import { toolRoutes } from './handlers/tools';
import { workflowItemRoutes } from './handlers/workflow-items';
import { workflowRoutes } from './handlers/workflows';
import type { ApiRoute } from './types';

export const apiRoutes: ApiRoute[] = [
  ...authRoutes,
  ...workflowRoutes,
  ...workflowItemRoutes,
  ...recordRoutes,
  ...schemaRoutes,
  ...agentRoutes,
  ...toolRoutes,
  ...httpRoutes,
  ...dataRoutes,
  ...publicWebhookRoutes
];

export {
  agentRoutes,
  authRoutes,
  dataRoutes,
  httpRoutes,
  publicWebhookRoutes,
  recordRoutes,
  schemaRoutes,
  toolRoutes,
  workflowItemRoutes,
  workflowRoutes
};
