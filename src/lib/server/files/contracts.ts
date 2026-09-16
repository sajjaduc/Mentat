/**
 * File service contract.
 *
 * Triggers, HTTP connectors and agent tools ingest and read files, but they must
 * not know how blobs, dedupe or processing work. This module is the seam: the
 * implementation lives in `files/service.ts` and is installed once at bootstrap.
 */
import type { ActorContext } from '../core/context';
import type { Executor } from '../db/client';

export type FileSourceType =
  | 'human_upload'
  | 'incoming_email'
  | 'incoming_message'
  | 'webhook'
  | 'agent_run'
  | 'http_connector'
  | 'api'
  | 'system';

export interface IngestFileInput {
  filename: string;
  bytes: Uint8Array;
  mimeType?: string;
  /** Where these bytes came from. Required: provenance is not optional. */
  source: {
    type: FileSourceType;
    reference?: string | null;
    label?: string | null;
    occurredAt?: number;
    detail?: Record<string, unknown>;
    ticketId?: string | null;
    triggerEventId?: string | null;
  };
  kind?: 'upload' | 'generated' | 'external';
  workflowId?: string | null;
  /** Link the resulting logical file to a ticket in the same transaction. */
  ticketId?: string | null;
  relationship?: 'attachment' | 'reference' | 'output' | 'evidence';
  /** Queue durable processing after ingest. Defaults to true. */
  process?: boolean;
  runId?: string | null;
  /** When false, reuses an existing compatible processing result. */
  forceReprocess?: boolean;
}

export interface IngestFileResult {
  fileId: string;
  blobId: string;
  contentHash: string;
  size: number;
  /** True when the bytes already existed for this workspace. */
  deduplicated: boolean;
  /** True when a logical file row was reused rather than created. */
  reusedFile: boolean;
  processingQueued: boolean;
}

export interface FileSummaryView {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  status: string;
  summary: string | null;
  contentHash: string;
  createdAt: number;
  provenance: { sourceType: string; sourceLabel: string | null } | null;
  workflowIds: string[];
  ticketIds: string[];
}

export interface FileService {
  ingest(actor: ActorContext, input: IngestFileInput, db?: Executor): Promise<IngestFileResult>;
  requireFile(actor: ActorContext, fileId: string, db?: Executor): Promise<FileSummaryView>;
  listForTicket(actor: ActorContext, ticketId: string, db?: Executor): Promise<FileSummaryView[]>;
  linkToTicket(
    actor: ActorContext,
    input: {
      fileId: string;
      ticketId: string;
      relationship?: 'attachment' | 'reference' | 'output' | 'evidence';
      caption?: string | null;
      runId?: string | null;
    },
    db?: Executor
  ): Promise<void>;
  addWorkflowContext(
    actor: ActorContext,
    input: { fileId: string; workflowId: string; contextLabel?: string | null },
    db?: Executor
  ): Promise<void>;
  getExtractedText(
    actor: ActorContext,
    fileId: string,
    db?: Executor
  ): Promise<{ text: string; pageCount: number | null; createdAt: number } | null>;
  queueProcessing(
    actor: ActorContext,
    input: { fileId: string; workflowId?: string | null; force?: boolean },
    db?: Executor
  ): Promise<void>;
}

let installed: FileService | null = null;

export function setFileService(service: FileService | null): void {
  installed = service;
}

export function fileService(): FileService {
  if (!installed) {
    throw new Error(
      'FileService is not installed. Call setFileService() during bootstrap before using file operations.'
    );
  }
  return installed;
}

export function hasFileService(): boolean {
  return installed !== null;
}
