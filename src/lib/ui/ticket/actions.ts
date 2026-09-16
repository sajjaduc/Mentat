/**
 * The mutation surface a ticket panel may call.
 *
 * Declared once so the Overview, Agent Work and Artifacts panels all describe the
 * same operations; the drawer supplies the implementation, which is where the
 * optimistic updates and rollbacks live.
 */
export interface TransitionRequest {
  transitionId?: string;
  targetStateId?: string;
  comment?: string;
  fieldValues?: Record<string, unknown>;
}

export interface TicketActions {
  /** Merge native ticket fields; resolves false when the server refused and rolled back. */
  patchTicket: (patch: Record<string, unknown>) => Promise<boolean>;
  /** Move the ticket; resolves an error message, or null on success. */
  transition: (request: TransitionRequest) => Promise<string | null>;
  /** Write one typed field value optimistically. */
  setField: (key: string, value: unknown) => Promise<void>;
  addLabel: (input: { labelId?: string; name?: string }) => Promise<void>;
  removeLabel: (labelId: string) => Promise<void>;
  addNote: (body: string) => Promise<void>;
  linkRelationship: (toTicketId: string, type: string, note?: string) => Promise<void>;
  unlinkRelationship: (relationshipId: string) => Promise<void>;
  attachFile: (input: { fileId: string; relationship?: string; caption?: string }) => Promise<void>;
  unlinkFile: (fileId: string) => Promise<void>;
  transfer: (input: {
    targetWorkflowId: string;
    targetStateId?: string;
    reason?: string;
    fieldMappings?: Record<string, string>;
  }) => Promise<void>;
  dispatch: (stateId?: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  refresh: () => Promise<void>;
}
