/**
 * Display vocabulary shared by every work surface.
 *
 * Tone and label decisions live here so a state, a priority and a run status mean
 * the same colour everywhere — the board, the drawer and the approvals inbox must
 * never disagree about what "urgent" looks like.
 */
import { formatDurationShort } from '$shared/format';

export type Tone = 'neutral' | 'accent' | 'positive' | 'caution' | 'danger' | 'muted';

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

const PRIORITY_LABELS: Record<Priority, string> = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent'
};

const PRIORITY_TONES: Record<Priority, Tone> = {
  none: 'muted',
  low: 'neutral',
  medium: 'accent',
  high: 'caution',
  urgent: 'danger'
};

export function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority as Priority] ?? priority;
}

export function priorityTone(priority: string): Tone {
  return PRIORITY_TONES[priority as Priority] ?? 'neutral';
}

const STATE_KIND_LABELS: Record<string, string> = {
  manual: 'Manual',
  agent: 'Agent',
  system: 'System',
  terminal: 'Terminal'
};

const STATE_KIND_TONES: Record<string, Tone> = {
  manual: 'neutral',
  agent: 'accent',
  system: 'muted',
  terminal: 'positive'
};

export function stateKindLabel(kind: string): string {
  return STATE_KIND_LABELS[kind] ?? kind;
}

export function stateKindTone(kind: string): Tone {
  return STATE_KIND_TONES[kind] ?? 'neutral';
}

const RUN_STATUS_TONES: Record<string, Tone> = {
  queued: 'muted',
  running: 'accent',
  succeeded: 'positive',
  failed: 'danger',
  cancelled: 'neutral',
  awaiting_approval: 'caution',
  skipped: 'neutral'
};

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  awaiting_approval: 'Awaiting approval',
  skipped: 'Skipped'
};

export function runStatusTone(status: string): Tone {
  return RUN_STATUS_TONES[status] ?? 'neutral';
}

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

const APPROVAL_STATUS_TONES: Record<string, Tone> = {
  pending: 'caution',
  approved: 'positive',
  rejected: 'danger',
  cancelled: 'neutral',
  expired: 'muted'
};

export function approvalStatusTone(status: string): Tone {
  return APPROVAL_STATUS_TONES[status] ?? 'neutral';
}

const RELATIONSHIP_LABELS: Record<string, string> = {
  parent: 'Parent',
  child: 'Child',
  related: 'Related',
  duplicate: 'Duplicate',
  blocks: 'Blocks',
  blocked_by: 'Blocked by'
};

export function relationshipLabel(type: string): string {
  return RELATIONSHIP_LABELS[type] ?? type;
}

export function relationshipTypeTone(type: string): Tone {
  if (type === 'blocks' || type === 'blocked_by') return 'danger';
  if (type === 'duplicate') return 'muted';
  if (type === 'parent' || type === 'child') return 'accent';
  return 'neutral';
}

/** Human label for a run event type, used by the live activity feed. */
const EVENT_LABELS: Record<string, string> = {
  'run.queued': 'Run queued',
  'run.started': 'Run started',
  'run.output.delta': 'Agent output',
  'run.reasoning.delta': 'Agent reasoning',
  'step.started': 'Step started',
  'step.completed': 'Step completed',
  'tool.started': 'Tool called',
  'tool.completed': 'Tool completed',
  'tool.failed': 'Tool failed',
  'approval.requested': 'Approval requested',
  'approval.decided': 'Approval decided',
  'retry.scheduled': 'Retry scheduled',
  'state.transition': 'State transition',
  'ticket.field.changed': 'Field changed',
  'ticket.note.added': 'Note added',
  'ticket.file.attached': 'File attached',
  'run.paused': 'Run paused',
  'run.resumed': 'Run resumed',
  'run.completed': 'Run completed',
  'run.failed': 'Run failed',
  'run.cancelled': 'Run cancelled',
  'ticket.updated': 'Ticket updated',
  'stream.ready': 'Stream ready'
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

export function eventTone(type: string): Tone {
  if (type === 'run.failed' || type === 'tool.failed') return 'danger';
  if (type === 'run.completed') return 'positive';
  if (type === 'approval.requested' || type === 'run.paused') return 'caution';
  if (type.startsWith('tool.')) return 'accent';
  if (type === 'state.transition' || type === 'ticket.field.changed') return 'accent';
  return 'neutral';
}

/** Age of the current state entry, rendered as a compact duration. */
export function ageInState(enteredStateAt: number | null | undefined, now = Date.now()): string {
  if (!enteredStateAt) return '—';
  return formatDurationShort(Math.max(0, now - enteredStateAt));
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
