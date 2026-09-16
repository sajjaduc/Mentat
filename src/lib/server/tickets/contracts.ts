/**
 * Ticket service contract.
 *
 * Triggers, files, HTTP tools and agent tools all need to create and mutate
 * tickets, but importing the implementation directly would create cycles
 * (tickets → files → tickets, triggers → tickets → triggers). This module defines
 * the interface those callers depend on plus a late-bound locator.
 *
 * The locator is a deliberate, narrow seam: it is populated once during server
 * bootstrap, it has no ambient state of its own, and tests can install a fake.
 * Everything else in the codebase imports concrete services.
 */
import type { ActorContext } from '../core/context';
import type { Executor } from '../db/client';
import type { TicketPriority, TicketRelationshipType, TicketStatusWait } from './types';

export interface CreateTicketInput {
  workflowId: string;
  /** Defaults to the workflow's default/start state. */
  stateId?: string | null;
  title: string;
  description?: string | null;
  priority?: TicketPriority;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  /** Typed field values keyed by field definition key. */
  fields?: Record<string, unknown>;
  /** Free-form values with no field definition. */
  structuredData?: Record<string, unknown>;
  labelIds?: string[];
  labelNames?: string[];
  /** Attach already-ingested files at creation time. */
  fileIds?: string[];
  /** Link the new ticket to an existing one. */
  originTicketId?: string | null;
  parentTicketId?: string | null;
  relationships?: Array<{ ticketId: string; type: TicketRelationshipType; note?: string }>;
  provenance?: {
    sourceType?: string;
    sourceReference?: string;
    sourceLabel?: string;
    triggerId?: string;
    triggerEventId?: string;
    externalRef?: string;
  };
  /** Suppress the state-entry execution (used when the caller owns dispatch). */
  deferExecution?: boolean;
  /** Idempotency guard for retried trigger deliveries. */
  dedupeKey?: string | null;
}

export interface TicketSummary {
  id: string;
  key: string;
  number: number;
  title: string;
  workflowId: string;
  stateId: string;
  priority: TicketPriority;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface TransitionRequest {
  transitionId?: string;
  targetStateId?: string;
  comment?: string | null;
  /** Populated when the transition comes from an agent run. */
  runId?: string | null;
}

export interface TicketService {
  create(actor: ActorContext, input: CreateTicketInput, db?: Executor): Promise<TicketSummary>;
  requireTicket(actor: ActorContext, ticketId: string, db?: Executor): Promise<TicketSummary>;
  addNote(
    actor: ActorContext,
    input: {
      ticketId: string;
      body: string;
      isSystem?: boolean;
      runId?: string | null;
      authorLabel?: string;
    },
    db?: Executor
  ): Promise<{ noteId: string }>;
  setFields(
    actor: ActorContext,
    input: {
      ticketId: string;
      values: Record<string, unknown>;
      runId?: string | null;
      source?: 'human' | 'agent' | 'system' | 'extraction';
      /** Skips field-permission checks — only for system actors. */
      force?: boolean;
    },
    db?: Executor
  ): Promise<{ changed: Array<{ key: string; previous: unknown; next: unknown }> }>;
  requestTransition(
    actor: ActorContext,
    ticketId: string,
    request: TransitionRequest,
    db?: Executor
  ): Promise<{ enteredStateId: string; transitionId: string | null }>;
  transfer(
    actor: ActorContext,
    ticketId: string,
    input: {
      targetWorkflowId: string;
      targetStateId?: string | null;
      fieldMappings?: Record<string, string>;
      reason?: string | null;
      runId?: string | null;
    },
    db?: Executor
  ): Promise<{ ticketId: string; workflowId: string; stateId: string }>;
  attachFile(
    actor: ActorContext,
    input: {
      ticketId: string;
      fileId: string;
      relationship?: 'attachment' | 'reference' | 'output' | 'evidence';
      caption?: string | null;
      runId?: string | null;
    },
    db?: Executor
  ): Promise<void>;
  linkRelationship(
    actor: ActorContext,
    input: {
      fromTicketId: string;
      toTicketId: string;
      type: TicketRelationshipType;
      note?: string | null;
      runId?: string | null;
    },
    db?: Executor
  ): Promise<void>;
  setWaitingOn(
    actor: ActorContext,
    ticketId: string,
    waitingOn: TicketStatusWait,
    db?: Executor
  ): Promise<void>;
}

let installed: TicketService | null = null;

/** Install the implementation. Called once from server bootstrap and in tests. */
export function setTicketService(service: TicketService | null): void {
  installed = service;
}

export function ticketService(): TicketService {
  if (!installed) {
    throw new Error(
      'TicketService is not installed. Call setTicketService() during bootstrap before using ticket operations.'
    );
  }
  return installed;
}

export function hasTicketService(): boolean {
  return installed !== null;
}
