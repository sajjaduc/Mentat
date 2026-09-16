/**
 * Native ticket tools.
 *
 * These are the controlled operations an agent uses to change work. Every one of
 * them goes through the same service layer a human uses, so validation, workflow
 * policy (including human gates and transfer rules), history and audit are
 * identical regardless of who is acting — an agent is a participant, not a
 * privileged back door (plan §35).
 *
 * Input schemas are real: the registry and runner validate arguments against them
 * before a handler runs, so malformed model output cannot reach domain code.
 */
import { z } from 'zod';
import { assertNativeCapability } from '../../agents/permissions';
import { errors, toAppError } from '../../core/errors';
import { listWorkflowFields } from '../../fields/service';
import {
  addNoteSync,
  attachFileSync,
  createTicketSync,
  evaluateTransferPolicy,
  getTicketDetail,
  linkRelationshipSync,
  requestTransitionSync,
  requireTicketSync,
  transferTicketSync,
  updateTicketSync
} from '../../tickets/service';
import { fieldValuesByKey, writeTicketFieldValues } from '../../tickets/values';
import { requireState } from '../../workflows/service';
import { defineNativeTool, type NativeToolHandler, toolFailure, toolSuccess } from '../types';

const TICKET_GET = 'mentat.ticket.get';
const FIELDS_GET = 'mentat.ticket.fields.get';
const FIELDS_SET = 'mentat.ticket.fields.set';
const FIELDS_SET_MANY = 'mentat.ticket.fields.setMany';
const ADD_NOTE = 'mentat.ticket.addNote';
const ADD_ARTIFACT = 'mentat.ticket.addArtifact';
const REQUEST_TRANSITION = 'mentat.ticket.requestTransition';
const TRANSFER = 'mentat.ticket.transfer';
const LINK_RELATIONSHIP = 'mentat.ticket.linkRelationship';
const CREATE_TICKET = 'tickets.create';

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

const stringProp = (description: string) => ({ type: 'string', description });
const arrayProp = (description: string, items: Record<string, unknown>) => ({
  type: 'array',
  description,
  items
});

/**
 * Resolve the ticket a tool call refers to. Calls default to the ticket the run is
 * working on, which keeps prompts short and prevents an agent from reaching for an
 * unrelated ticket by accident.
 */
function resolveTicket(
  context: Parameters<NativeToolHandler['execute']>[1],
  explicitId?: string | null
) {
  const ticketId = explicitId ?? context.ticketId;
  if (!ticketId) {
    throw errors.validation('This call needs a ticketId: no ticket is in scope for the run');
  }
  const ticket = requireTicketSync(context.db, context.actor.workspaceId, ticketId);
  return ticket;
}

export const ticketGetTool = defineNativeTool({
  key: TICKET_GET,
  name: 'Get ticket',
  description:
    'Read a ticket: title, description, state, priority, owner, labels and typed field values.',
  inputSchema: objectSchema({
    ticketId: stringProp('Ticket id. Defaults to the ticket this run is working on.')
  }),
  outputSchema: objectSchema({
    ticket: { type: 'object' },
    fields: { type: 'object' },
    state: { type: 'object' }
  }),
  permission: 'ticket:read',
  async execute(input: { ticketId?: string } | undefined, context) {
    const ticket = resolveTicket(context, input?.ticketId);
    const state = requireState(context.db, ticket.workspaceId, ticket.stateId);
    const workflowFields = listWorkflowFields(context.db, context.actor, ticket.workflowId);
    return toolSuccess({
      ticket: {
        id: ticket.id,
        key: ticket.key,
        title: ticket.title,
        description: ticket.description,
        priority: ticket.priority,
        stateId: ticket.stateId,
        workflowId: ticket.workflowId,
        ownerUserId: ticket.ownerUserId,
        ownerTeamId: ticket.ownerTeamId,
        version: ticket.version,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt
      },
      state: { id: state.id, name: state.name, kind: state.kind, category: state.category },
      fields: fieldValuesByKey(context.db, ticket.workspaceId, ticket.id),
      configurableFields: workflowFields.map((view) => ({
        key: view.definition.key,
        name: view.definition.name,
        type: view.definition.type,
        required: view.required,
        editable: view.editable
      }))
    });
  }
});

export const ticketFieldsGetTool = defineNativeTool({
  key: FIELDS_GET,
  name: 'Get ticket fields',
  description: 'Read the typed field values of a ticket, optionally limited to specific keys.',
  inputSchema: objectSchema({
    ticketId: stringProp('Ticket id. Defaults to the ticket in scope.'),
    keys: arrayProp('Field keys to read. Omit for all fields with values.', { type: 'string' })
  }),
  permission: 'ticket:read',
  async execute(input: { ticketId?: string; keys?: string[] } | undefined, context) {
    const ticket = resolveTicket(context, input?.ticketId);
    const values = fieldValuesByKey(context.db, ticket.workspaceId, ticket.id);
    if (input?.keys && input.keys.length > 0) {
      const filtered: Record<string, unknown> = {};
      for (const key of input.keys) filtered[key] = values[key] ?? null;
      return toolSuccess({ fields: filtered });
    }
    return toolSuccess({ fields: values });
  }
});

export const ticketFieldsSetTool = defineNativeTool({
  key: FIELDS_SET,
  name: 'Set a ticket field',
  description:
    'Set one typed field value. Validates the field type, workflow policy and audit history. Use the exact field key reported by mentat.ticket.get.',
  inputSchema: objectSchema(
    {
      ticketId: stringProp('Ticket id. Defaults to the ticket in scope.'),
      fieldKey: stringProp('Field key, e.g. claim_amount'),
      value: {
        description:
          'New value. Use a number for number/currency, an ISO date for date, a choice value for select, an array for multi-select, or null to clear.'
      }
    },
    ['fieldKey']
  ),
  permission: 'ticket:write',
  async execute(input: { ticketId?: string; fieldKey: string; value?: unknown }, context) {
    assertNativeCapability(
      context.actor.permissions,
      [FIELDS_SET, 'ticket.fields.set'],
      'change ticket fields'
    );
    const ticket = resolveTicket(context, input.ticketId);
    const changed = writeTicketFieldValues(context.db, {
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      workflowId: ticket.workflowId,
      values: { [input.fieldKey]: input.value },
      actor: context.actor,
      runId: context.runId ?? null,
      source: 'agent'
    });
    updateTicketSync(context.db, context.actor, { ticketId: ticket.id });
    return toolSuccess({ changed });
  }
});

export const ticketFieldsSetManyTool = defineNativeTool({
  key: FIELDS_SET_MANY,
  name: 'Set several ticket fields',
  description:
    'Set multiple typed fields in one validated write. Prefer this over repeated single-field calls when you have extracted several values at once.',
  inputSchema: objectSchema(
    {
      ticketId: stringProp('Ticket id. Defaults to the ticket in scope.'),
      values: {
        type: 'object',
        description: 'Map of field key to new value.'
      }
    },
    ['values']
  ),
  permission: 'ticket:write',
  async execute(input: { ticketId?: string; values: Record<string, unknown> }, context) {
    assertNativeCapability(
      context.actor.permissions,
      [FIELDS_SET_MANY, 'ticket.fields.setMany', 'ticket.fields.set'],
      'change ticket fields'
    );
    const ticket = resolveTicket(context, input.ticketId);
    const changed = writeTicketFieldValues(context.db, {
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      workflowId: ticket.workflowId,
      values: input.values,
      actor: context.actor,
      runId: context.runId ?? null,
      source: 'agent'
    });
    updateTicketSync(context.db, context.actor, { ticketId: ticket.id });
    return toolSuccess({ changed, count: changed.length });
  }
});

export const ticketAddNoteTool = defineNativeTool({
  key: ADD_NOTE,
  name: 'Add a ticket note',
  description:
    'Append a note to the ticket journal. Use it to record findings, decisions and handover context.',
  inputSchema: objectSchema(
    {
      ticketId: stringProp('Ticket id. Defaults to the ticket in scope.'),
      body: stringProp('Note text.')
    },
    ['body']
  ),
  permission: 'ticket:write',
  async execute(input: { ticketId?: string; body: string }, context) {
    assertNativeCapability(
      context.actor.permissions,
      [ADD_NOTE, 'ticket.note.add'],
      'add notes to tickets'
    );
    const ticket = resolveTicket(context, input.ticketId);
    const note = addNoteSync(context.db, context.actor, {
      ticketId: ticket.id,
      body: input.body,
      runId: context.runId ?? null
    });
    return toolSuccess({ noteId: note.id });
  }
});

export const ticketAddArtifactTool = defineNativeTool({
  key: ADD_ARTIFACT,
  name: 'Attach a file to a ticket',
  description:
    'Link an existing ingested file to the ticket as an artifact. Use files.* tools to ingest new content first.',
  inputSchema: objectSchema(
    {
      ticketId: stringProp('Ticket id. Defaults to the ticket in scope.'),
      fileId: stringProp('Id of an ingested file.'),
      relationship: stringProp('attachment | reference | output | evidence (default attachment).'),
      caption: stringProp('Optional caption describing why this file matters.')
    },
    ['fileId']
  ),
  permission: 'ticket:write',
  async execute(
    input: { ticketId?: string; fileId: string; relationship?: string; caption?: string },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      [ADD_ARTIFACT, 'ticket.artifact.add'],
      'attach artifacts to tickets'
    );
    const ticket = resolveTicket(context, input.ticketId);
    const relationship = normalizeRelationship(input.relationship);
    attachFileSync(context.db, context.actor, {
      ticketId: ticket.id,
      fileId: input.fileId,
      relationship,
      caption: input.caption ?? null,
      runId: context.runId ?? null
    });
    return toolSuccess({ ticketId: ticket.id, fileId: input.fileId, relationship });
  }
});

function normalizeRelationship(
  value: string | undefined
): 'attachment' | 'reference' | 'output' | 'evidence' {
  const allowed = ['attachment', 'reference', 'output', 'evidence'] as const;
  if (!value) return 'attachment';
  const match = allowed.find((entry) => entry === value);
  return match ?? 'attachment';
}

export const ticketRequestTransitionTool = defineNativeTool({
  key: REQUEST_TRANSITION,
  name: 'Request a state transition',
  description:
    'Ask Mentat to move the ticket to another state. Mentat validates the transition, required fields, role rules and human gates; a human-gated state refuses automatically and the ticket waits for a person.',
  inputSchema: objectSchema({
    ticketId: stringProp('Ticket id. Defaults to the ticket in scope.'),
    targetStateId: stringProp('Destination state id.'),
    transitionId: stringProp('Transition id, when the destination is ambiguous.'),
    comment: stringProp('Reason for the move. Required by some transitions.')
  }),
  permission: 'ticket:write',
  async execute(
    input: { ticketId?: string; targetStateId?: string; transitionId?: string; comment?: string },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      [REQUEST_TRANSITION, 'ticket.transition.request'],
      'move tickets between states'
    );
    const ticket = resolveTicket(context, input.ticketId);
    const applied = requestTransitionSync(context.db, context.actor, {
      ticketId: ticket.id,
      targetStateId: input.targetStateId ?? null,
      transitionId: input.transitionId ?? null,
      comment: input.comment ?? null,
      runId: context.runId ?? null,
      viaRun: true
    });
    return toolSuccess(applied);
  }
});

export const ticketTransferTool = defineNativeTool({
  key: TRANSFER,
  name: 'Transfer the ticket to another workflow',
  description:
    'Move this ticket to a different workflow, preserving its identity, notes, artifacts and history. Mentat enforces transfer policy and required destination fields; if a policy requires approval the transfer is refused until a human approves.',
  inputSchema: objectSchema(
    {
      ticketId: stringProp('Ticket id. Defaults to the ticket in scope.'),
      targetWorkflowId: stringProp('Destination workflow id.'),
      targetStateId: stringProp('Destination state id. Defaults to the workflow default.'),
      reason: stringProp('Why this ticket belongs in the destination workflow.'),
      fieldMappings: {
        type: 'object',
        description: 'Map of source field key to destination field key, for renamed fields.'
      }
    },
    ['targetWorkflowId']
  ),
  permission: 'ticket:transfer',
  async execute(
    input: {
      ticketId?: string;
      targetWorkflowId: string;
      targetStateId?: string;
      reason?: string;
      fieldMappings?: Record<string, string>;
    },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      [TRANSFER, 'ticket.transfer'],
      'transfer tickets between workflows'
    );
    const ticket = resolveTicket(context, input.ticketId);
    const policy = evaluateTransferPolicy(context.db, context.actor, {
      ticket,
      targetWorkflowId: input.targetWorkflowId
    });
    if (!policy.allowed) {
      return toolFailure({
        code: 'policy_denied',
        message: policy.reason ?? 'Transfer is not permitted'
      });
    }
    if (policy.requiresApproval) {
      return toolFailure({
        code: 'approval_required',
        message:
          'This transfer requires human approval. Ask a human reviewer to approve it before retrying.'
      });
    }
    const result = transferTicketSync(context.db, context.actor, {
      ticketId: ticket.id,
      targetWorkflowId: input.targetWorkflowId,
      targetStateId: input.targetStateId ?? null,
      fieldMappings: input.fieldMappings,
      reason: input.reason ?? null,
      runId: context.runId ?? null
    });
    return toolSuccess(result);
  }
});

export const ticketLinkRelationshipTool = defineNativeTool({
  key: LINK_RELATIONSHIP,
  name: 'Link two tickets',
  description:
    'Create a first-class relationship (parent, child, related, duplicate, blocks, blocked_by) between this ticket and another.',
  inputSchema: objectSchema(
    {
      fromTicketId: stringProp('Source ticket id. Defaults to the ticket in scope.'),
      toTicketId: stringProp('The other ticket id.'),
      type: stringProp('parent | child | related | duplicate | blocks | blocked_by'),
      note: stringProp('Optional note explaining the relationship.')
    },
    ['toTicketId', 'type']
  ),
  permission: 'ticket:write',
  async execute(
    input: { fromTicketId?: string; toTicketId: string; type: string; note?: string },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      [LINK_RELATIONSHIP, 'ticket.relationship.link'],
      'link tickets'
    );
    const from = resolveTicket(context, input.fromTicketId);
    const allowed = ['parent', 'child', 'related', 'duplicate', 'blocks', 'blocked_by'] as const;
    const type = allowed.find((entry) => entry === input.type);
    if (!type) {
      return toolFailure({
        code: 'validation_failed',
        message: `type must be one of: ${allowed.join(', ')}`
      });
    }
    const id = linkRelationshipSync(context.db, context.actor, {
      fromTicketId: from.id,
      toTicketId: input.toTicketId,
      type,
      note: input.note ?? null,
      runId: context.runId ?? null
    });
    return toolSuccess({
      relationshipId: id,
      fromTicketId: from.id,
      toTicketId: input.toTicketId,
      type
    });
  }
});

export const ticketCreateTool = defineNativeTool({
  key: CREATE_TICKET,
  name: 'Create a ticket',
  description:
    'Create a new ticket, optionally in another workflow, as a child of the current one. Use this to decompose work: one intake ticket can produce several independent child tickets routed to specialist workflows.',
  inputSchema: objectSchema(
    {
      workflowId: stringProp('Target workflow id.'),
      title: stringProp('Ticket title.'),
      description: stringProp('Ticket description.'),
      stateId: stringProp('Initial state id. Defaults to the workflow default.'),
      priority: stringProp('none | low | medium | high | urgent'),
      fields: { type: 'object', description: 'Typed field values keyed by field key.' },
      parentTicketId: stringProp('Parent ticket id. Defaults to the ticket in scope.'),
      labels: arrayProp('Label names to apply.', { type: 'string' }),
      reason: stringProp('Why this ticket is being created; recorded in provenance.')
    },
    ['workflowId', 'title']
  ),
  permission: 'ticket:create',
  async execute(
    input: {
      workflowId: string;
      title: string;
      description?: string;
      stateId?: string;
      priority?: string;
      fields?: Record<string, unknown>;
      parentTicketId?: string;
      labels?: string[];
      reason?: string;
    },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      [CREATE_TICKET, 'tickets.create'],
      'create tickets'
    );
    if (context.actor.actorType === 'agent' && !context.actor.permissions.has('ticket:create')) {
      return toolFailure({
        code: 'policy_denied',
        message: 'This agent is not permitted to create tickets'
      });
    }
    const priorities = ['none', 'low', 'medium', 'high', 'urgent'] as const;
    const priority = priorities.find((entry) => entry === input.priority) ?? 'none';
    const parentTicketId = input.parentTicketId ?? context.ticketId ?? null;

    const created = createTicketSync(context.db, context.actor, {
      workflowId: input.workflowId,
      title: input.title,
      description: input.description ?? null,
      stateId: input.stateId ?? null,
      priority,
      fields: input.fields,
      labelNames: input.labels ?? [],
      parentTicketId,
      provenance: {
        sourceType: context.actor.actorType === 'agent' ? 'agent_run' : 'api',
        sourceLabel: context.actor.actorLabel ?? 'Agent',
        sourceReference: input.reason ?? null,
        externalRef: null
      }
    });
    return toolSuccess(created);
  }
});

/** Ticket tools owned by the execution workstream. */
export const ticketTools: NativeToolHandler[] = [
  ticketGetTool,
  ticketFieldsGetTool,
  ticketFieldsSetTool,
  ticketFieldsSetManyTool,
  ticketAddNoteTool,
  ticketAddArtifactTool,
  ticketRequestTransitionTool,
  ticketTransferTool,
  ticketLinkRelationshipTool,
  ticketCreateTool
];

export const ticketToolKeys = ticketTools.map((tool) => tool.key);

/** Zod schemas are used by the API layer for the same operations. */
export const ticketApiSchemas = {
  setFields: z.object({ values: z.record(z.string(), z.unknown()) }),
  transition: z.object({
    targetStateId: z.string().optional(),
    transitionId: z.string().optional(),
    comment: z.string().max(2000).optional()
  }),
  transfer: z.object({
    targetWorkflowId: z.string(),
    targetStateId: z.string().optional(),
    reason: z.string().max(2000).optional(),
    fieldMappings: z.record(z.string(), z.string()).optional()
  })
};

/** Exposed for the ticket detail route so the drawer and tools show the same shape. */
export async function ticketDetailForTool(
  context: Parameters<NativeToolHandler['execute']>[1],
  ticketId: string
) {
  return getTicketDetail(context.db, context.actor, ticketId);
}

export { toAppError };
