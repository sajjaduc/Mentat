/**
 * Ticket API.
 *
 * Everything the board, the list, the ticket drawer and the Agent Work surface
 * need. Mutations route through the ticket/field/state-machine services so the
 * browser cannot do anything an agent or a trigger could not do — and vice versa.
 */
import { z } from 'zod';
import { Permissions } from '../../core/context';
import { cancelAgentRunSync, dispatchStateEntrySync } from '../../execution/engine';
import { listRunEvents } from '../../execution/events';
import { getRunDetail, listTicketRuns } from '../../execution/runner';
import { listWorkflowFields } from '../../fields/service';
import { unlinkFromTicket } from '../../files/lifecycle';
import {
  addLabelsToTicket,
  createLabel,
  listLabels,
  removeLabelFromTicket
} from '../../tickets/labels';
import { parseFilterInput } from '../../tickets/query';
import {
  addNoteSync,
  attachFileSync,
  createTicketSync,
  deleteNoteSync,
  editNoteSync,
  getTicketDetail,
  linkRelationshipSync,
  myWork,
  requestTransitionSync,
  requireTicketSync,
  searchTickets,
  ticketFieldChanges,
  ticketTimeline,
  transferTicketSync,
  unlinkRelationshipSync,
  updateTicketSync
} from '../../tickets/service';
import type { TicketRelationshipType } from '../../tickets/types';
import { fieldValuesByKey, writeTicketFieldValues } from '../../tickets/values';
import { mutate, queryInt, queryString } from '../helpers';
import { route } from '../types';

const prioritySchema = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const relationshipSchema = z.enum([
  'parent',
  'child',
  'related',
  'duplicate',
  'blocks',
  'blocked_by'
]);

export const ticketRoutes = [
  route({
    method: 'GET',
    path: '/tickets',
    permission: Permissions.ticketRead,
    summary: 'List or search tickets with filter AST, sort and keyset pagination',
    handler: async ({ db, actor, query }) => {
      const options = (query ?? {}) as {
        workflowId?: string;
        stateIds?: string[];
        filter?: unknown;
        sort?: unknown;
        limit?: number;
        cursor?: string;
        search?: string;
      };
      const page = await searchTickets(db, actor, {
        workflowId: options.workflowId ?? null,
        stateIds: options.stateIds,
        filter: parseFilterInput(options.filter ?? null),
        sort: options.sort as Array<{ field: string; direction: 'asc' | 'desc' }> | undefined,
        limit: options.limit ?? 50,
        cursor: options.cursor ?? null,
        search: options.search ?? null
      });
      return { body: page };
    }
  }),

  route({
    method: 'POST',
    path: '/tickets',
    permission: Permissions.ticketCreate,
    summary: 'Create a ticket',
    body: z.object({
      workflowId: z.string(),
      stateId: z.string().nullish(),
      title: z.string().trim().min(1).max(500),
      description: z.string().max(20_000).nullish(),
      priority: prioritySchema.optional(),
      ownerUserId: z.string().nullish(),
      ownerTeamId: z.string().nullish(),
      fields: z.record(z.string(), z.unknown()).optional(),
      structuredData: z.record(z.string(), z.unknown()).optional(),
      labelIds: z.array(z.string()).optional(),
      labelNames: z.array(z.string()).optional(),
      fileIds: z.array(z.string()).optional(),
      parentTicketId: z.string().nullish(),
      provenance: z.record(z.string(), z.unknown()).nullish()
    }),
    handler: ({ db, actor, body }) => ({
      status: 201,
      body: { ticket: mutate(db, (tx) => createTicketSync(tx, actor, body as never)) }
    })
  }),

  route({
    method: 'GET',
    path: '/tickets/:id',
    permission: Permissions.ticketRead,
    summary: 'Full ticket detail: fields, notes, files, runs, approvals and transitions',
    handler: async ({ db, actor, params }) => ({
      body: await getTicketDetail(db, actor, params.id as string)
    })
  }),

  route({
    method: 'PATCH',
    path: '/tickets/:id',
    permission: Permissions.ticketWrite,
    summary: 'Update native ticket fields (title, description, priority, owner, due date)',
    body: z.object({
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().max(20_000).nullish(),
      priority: prioritySchema.optional(),
      ownerUserId: z.string().nullish(),
      ownerTeamId: z.string().nullish(),
      dueAt: z.number().int().nullish(),
      expectedVersion: z.number().int().optional()
    }),
    handler: ({ db, actor, params, body }) => ({
      body: {
        ticket: mutate(db, (tx) =>
          updateTicketSync(tx, actor, {
            ticketId: params.id as string,
            ...(body as object)
          } as never)
        )
      }
    })
  }),

  route({
    method: 'GET',
    path: '/tickets/:id/fields',
    permission: Permissions.ticketRead,
    summary: 'Ticket field values plus the workflow’s field configuration',
    handler: ({ db, actor, params }) => {
      const ticket = requireTicketSync(db, actor.workspaceId, params.id as string);
      return {
        body: {
          fields: fieldValuesByKey(db, actor.workspaceId, ticket.id),
          config: listWorkflowFields(db, actor, ticket.workflowId).map((view) => ({
            key: view.definition.key,
            name: view.definition.name,
            type: view.definition.type,
            required: view.required,
            editable: view.editable,
            visible: view.visible,
            showOnCard: view.showOnCard,
            showInList: view.showInList,
            requiredInStates: view.requiredInStates,
            options: view.definition.options
          }))
        }
      };
    }
  }),

  route({
    method: 'PUT',
    path: '/tickets/:id/fields',
    permission: Permissions.ticketWrite,
    summary: 'Set typed field values with validation, history and audit',
    body: z.object({ values: z.record(z.string(), z.unknown()) }),
    handler: ({ db, actor, params, body }) => ({
      body: {
        changed: mutate(db, (tx) => {
          const ticket = requireTicketSync(tx, actor.workspaceId, params.id as string);
          return writeTicketFieldValues(tx, {
            workspaceId: actor.workspaceId,
            ticketId: ticket.id,
            workflowId: ticket.workflowId,
            values: (body as { values: Record<string, unknown> }).values,
            actor,
            source: 'human'
          });
        })
      }
    })
  }),

  route({
    method: 'GET',
    path: '/tickets/:id/field-history',
    permission: Permissions.ticketRead,
    summary: 'Append-only field change history',
    handler: async ({ db, actor, params }) => ({
      body: { history: await ticketFieldChanges(db, actor, params.id as string) }
    })
  }),

  // ------------------------------------------------------------------- notes
  route({
    method: 'POST',
    path: '/tickets/:id/notes',
    permission: Permissions.ticketWrite,
    summary: 'Add a note to the ticket journal',
    body: z.object({ body: z.string().trim().min(1).max(20_000) }),
    handler: ({ db, actor, params, body }) => ({
      status: 201,
      body: {
        note: mutate(db, (tx) =>
          addNoteSync(tx, actor, {
            ticketId: params.id as string,
            body: (body as { body: string }).body
          })
        )
      }
    })
  }),

  route({
    method: 'PATCH',
    path: '/notes/:id',
    permission: Permissions.ticketWrite,
    summary: 'Edit a note, retaining the previous revision',
    body: z.object({ body: z.string().trim().min(1).max(20_000) }),
    handler: async ({ db, actor, params, body }) => {
      await mutate(db, (tx) =>
        editNoteSync(tx, actor, {
          noteId: params.id as string,
          body: (body as { body: string }).body
        })
      );
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/notes/:id',
    permission: Permissions.ticketWrite,
    summary: 'Delete a note (soft delete, audited)',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => deleteNoteSync(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  // ------------------------------------------------------------- transitions
  route({
    method: 'POST',
    path: '/tickets/:id/transitions',
    permission: Permissions.ticketWrite,
    summary: 'Request a state transition; human gates are enforced here',
    body: z.object({
      transitionId: z.string().nullish(),
      targetStateId: z.string().nullish(),
      comment: z.string().max(2000).nullish(),
      fieldValues: z.record(z.string(), z.unknown()).optional()
    }),
    handler: ({ db, actor, params, body }) => ({
      body: mutate(db, (tx) =>
        requestTransitionSync(tx, actor, {
          ticketId: params.id as string,
          ...(body as object)
        } as never)
      )
    })
  }),

  route({
    method: 'POST',
    path: '/tickets/:id/transfer',
    permission: Permissions.ticketTransfer,
    summary: 'Move a ticket to another workflow, preserving identity and history',
    body: z.object({
      targetWorkflowId: z.string(),
      targetStateId: z.string().nullish(),
      reason: z.string().max(2000).nullish(),
      fieldMappings: z.record(z.string(), z.string()).optional(),
      approved: z.boolean().optional()
    }),
    handler: ({ db, actor, params, body }) => ({
      body: mutate(db, (tx) =>
        transferTicketSync(tx, actor, {
          ticketId: params.id as string,
          ...(body as object)
        } as never)
      )
    })
  }),

  // ------------------------------------------------------------ relationships
  route({
    method: 'POST',
    path: '/tickets/:id/relationships',
    permission: Permissions.ticketWrite,
    summary: 'Link two tickets (parent/child/related/duplicate/blocks)',
    body: z.object({
      toTicketId: z.string(),
      type: relationshipSchema,
      note: z.string().max(2000).nullish()
    }),
    handler: ({ db, actor, params, body }) => {
      const input = body as {
        toTicketId: string;
        type: TicketRelationshipType;
        note?: string | null;
      };
      return {
        status: 201,
        body: {
          relationshipId: mutate(db, (tx) =>
            linkRelationshipSync(tx, actor, {
              fromTicketId: params.id as string,
              toTicketId: input.toTicketId,
              type: input.type,
              note: input.note ?? null
            })
          )
        }
      };
    }
  }),

  route({
    method: 'DELETE',
    path: '/relationships/:id',
    permission: Permissions.ticketWrite,
    summary: 'Remove a ticket relationship',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => unlinkRelationshipSync(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  // ------------------------------------------------------------------ labels
  route({
    method: 'GET',
    path: '/labels',
    permission: Permissions.ticketRead,
    summary: 'Workspace labels',
    handler: ({ db, actor }) => ({ body: { labels: listLabels(db, actor) } })
  }),

  route({
    method: 'POST',
    path: '/labels',
    permission: Permissions.ticketWrite,
    summary: 'Create a label',
    body: z.object({
      name: z.string().trim().min(1).max(60),
      color: z.string().max(40).nullish(),
      description: z.string().max(500).nullish()
    }),
    handler: ({ db, actor, body }) => ({
      status: 201,
      body: { label: mutate(db, (tx) => createLabel(tx, actor, body as never)) }
    })
  }),

  route({
    method: 'POST',
    path: '/tickets/:id/labels',
    permission: Permissions.ticketWrite,
    summary: 'Add labels to a ticket',
    body: z.object({
      labelIds: z.array(z.string()).optional(),
      labelNames: z.array(z.string()).optional()
    }),
    handler: async ({ db, actor, params, body }) => {
      const input = body as { labelIds?: string[]; labelNames?: string[] };
      await mutate(db, (tx) => addLabelsToTicket(tx, actor, params.id as string, input));
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/tickets/:id/labels/:labelId',
    permission: Permissions.ticketWrite,
    summary: 'Remove a label from a ticket',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) =>
        removeLabelFromTicket(tx, actor, params.id as string, params.labelId as string)
      );
      return { status: 204 };
    }
  }),

  // ------------------------------------------------------------------- files
  route({
    method: 'POST',
    path: '/tickets/:id/files',
    permission: Permissions.ticketWrite,
    summary: 'Link an existing file to a ticket',
    body: z.object({
      fileId: z.string(),
      relationship: z.enum(['attachment', 'reference', 'output', 'evidence']).optional(),
      caption: z.string().max(500).nullish()
    }),
    handler: async ({ db, actor, params, body }) => {
      const input = body as { fileId: string; relationship?: string; caption?: string | null };
      await mutate(db, (tx) =>
        attachFileSync(tx, actor, {
          ticketId: params.id as string,
          fileId: input.fileId,
          relationship: (input.relationship as never) ?? 'attachment',
          caption: input.caption ?? null
        })
      );
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/tickets/:id/files/:fileId',
    permission: Permissions.ticketWrite,
    summary: 'Unlink a file from a ticket without deleting the file',
    handler: async ({ db, actor, params }) => {
      await unlinkFromTicket(
        actor,
        {
          ticketId: params.id as string,
          fileId: params.fileId as string
        },
        db
      );
      return { status: 204 };
    }
  }),

  // --------------------------------------------------------------- execution
  route({
    method: 'GET',
    path: '/tickets/:id/runs',
    permission: Permissions.runRead,
    summary: 'Agent runs for a ticket, oldest first',
    handler: async ({ db, actor, params }) => ({
      body: { runs: await listTicketRuns(db, actor.workspaceId, params.id as string) }
    })
  }),

  route({
    method: 'POST',
    path: '/tickets/:id/dispatch',
    permission: Permissions.runExecute,
    summary: 'Run the current (or a specified) state now',
    body: z.object({
      stateId: z.string().nullish(),
      reason: z.string().max(500).nullish(),
      force: z.boolean().optional()
    }),
    handler: ({ db, actor, params, body }) => ({
      body: mutate(db, (tx) =>
        dispatchStateEntrySync(tx, actor, {
          ticketId: params.id as string,
          ...(body as object)
        } as never)
      )
    })
  }),

  route({
    method: 'GET',
    path: '/runs/:id',
    permission: Permissions.runRead,
    summary: 'Run detail with steps, approvals and the agent version used',
    handler: async ({ db, actor, params }) => ({
      body: await getRunDetail(db, actor.workspaceId, params.id as string)
    })
  }),

  route({
    method: 'POST',
    path: '/runs/:id/cancel',
    permission: Permissions.runCancel,
    summary: 'Cancel a run and its pending approvals',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => cancelAgentRunSync(tx, actor, params.id as string));
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'GET',
    path: '/tickets/:id/timeline',
    permission: Permissions.ticketRead,
    summary: 'One coherent chronological ticket history, with filters',
    handler: async ({ db, actor, params, query }) => {
      const filter = queryString({ query } as never, 'filter');
      const limit = queryInt({ query } as never, 'limit', 200, { min: 1, max: 500 });
      return {
        body: {
          events: await ticketTimeline(db, actor, params.id as string, {
            limit,
            filter: (filter as never) ?? 'all'
          })
        }
      };
    }
  }),

  route({
    method: 'GET',
    path: '/tickets/:id/events',
    permission: Permissions.ticketRead,
    summary: 'Ticket-scoped run events for live-updating the drawer',
    handler: async ({ db, actor, params, query }) => {
      const since = queryInt({ query } as never, 'since', 0);
      return {
        body: {
          events: await listRunEvents(db, {
            workspaceId: actor.workspaceId,
            ticketId: params.id as string,
            since
          })
        }
      };
    }
  }),

  // --------------------------------------------------------------- work views
  route({
    method: 'GET',
    path: '/my-work',
    permission: Permissions.ticketRead,
    summary: 'Assigned, Waiting for me, Waiting for agent, Waiting for approval, Needs attention',
    handler: async ({ db, actor, query }) => ({
      body: await myWork(db, actor, {
        limit: queryInt({ query } as never, 'limit', 50, { min: 1, max: 200 })
      })
    })
  }),

  route({
    method: 'GET',
    path: '/search',
    permission: Permissions.ticketRead,
    summary: 'Command palette search across tickets, workflows, agents and files',
    handler: async ({ db, actor, query, request }) => {
      const term =
        queryString({ query } as never, 'q') ?? new URL(request.url).searchParams.get('q');
      if (!term || term.trim().length < 2) return { body: { results: [] } };
      const limit = queryInt({ query } as never, 'limit', 8, { min: 1, max: 25 });

      const tickets = await searchTickets(db, actor, { search: term, limit });
      const results: Array<Record<string, unknown>> = tickets.rows.map((row) => ({
        kind: 'ticket',
        id: row.ticket.id,
        key: row.ticket.key,
        title: row.ticket.title,
        subtitle: row.stateName,
        href: `/tickets/${row.ticket.id}`
      }));

      return { body: { results, total: tickets.total } };
    }
  }),

  route({
    method: 'GET',
    path: '/tickets/:id/file-values',
    permission: Permissions.ticketRead,
    summary: 'Typed field values only (used by the optimistic field editor)',
    handler: ({ db, actor, params }) => ({
      body: { fields: fieldValuesByKey(db, actor.workspaceId, params.id as string) }
    })
  })
];
