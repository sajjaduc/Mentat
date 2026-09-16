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
import { ticketRoutes } from './handlers/tickets';
import { workflowRoutes } from './handlers/workflows';
import type { ApiRoute } from './types';

export const apiRoutes: ApiRoute[] = [
  ...authRoutes,
  ...workflowRoutes,
  ...ticketRoutes,
  ...agentRoutes,
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
  ticketRoutes,
  workflowRoutes
};
