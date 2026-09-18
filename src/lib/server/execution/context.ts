/**
 * Agent context assembly.
 *
 * The plan is explicit that not every note, field and document should be injected
 * into every model call (§30 context control, follow-up §18). Assembly is driven
 * by the *state's* `AgentContextConfig`, so a state can request exactly the
 * record fields, recent notes, linked-file summaries and selected file fields it
 * needs — and nothing else.
 *
 * Secrets are never candidates for inclusion: this module only reads record
 * fields, notes, file summaries and history. Environment variables and secret
 * values are resolved separately, inside execution, and are never rendered into a
 * prompt.
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { assembleSkillInstructions } from '../agents/service';
import { errors } from '../core/errors';
import { createRedactor } from '../core/redaction';
import { registeredSecretValues } from '../core/secret-registry';
import type { Executor } from '../db/client';
import {
  type AgentContextConfig,
  type AgentSnapshot,
  files,
  fileWorkflowItems,
  recordNotes,
  records,
  workflowItemNotes,
  workflowItemStateHistory,
  workflowItems
} from '../db/schema';
import type { ChatMessage } from '../providers/types';
import { buildRecordContract, describeRecordContract } from '../records/contract';
import { requireObjectType } from '../records/object-types';
import { workflowItemFieldValuesByKey } from '../workflow-items/fields';

export interface AgentRunContext {
  messages: ChatMessage[];
  /** Redacted snapshot persisted on the run for inspection. */
  snapshot: Record<string, unknown>;
  sections: string[];
}

const DEFAULT_CONFIG: AgentContextConfig = {
  includeTitle: true,
  includeDescription: true,
  fieldKeys: [],
  includeRecentNotes: 5,
  includeFileSummaries: true,
  includeFileFields: [],
  includeFullFileContent: false,
  includeHistory: false,
  includeStateHistory: false
};

// ---------------------------------------------------------------------------
// Record-bound runs (ADR-0021 / ADR-0023)
// ---------------------------------------------------------------------------

export interface BuildRecordContextOptions {
  workspaceId: string;
  workflowItemId: string;
  recordId: string;
  workflowId: string;
  stateId: string;
  stateName: string;
  agent: AgentSnapshot;
  config: AgentContextConfig | null;
  extraInstructions?: string | null;
  /** When set, the run must finish with a validated submission via this tool. */
  requiredSubmission?: { toolKey?: string; allowWorkflowChange?: boolean } | null;
}

/**
 * Context for a run over a WorkflowItem of any Object Type. Input is the record
 * plus its effective schema and, when the state enforces one, the submission
 * contract the agent must satisfy.
 */
export async function buildRecordRunContext(
  db: Executor,
  options: BuildRecordContextOptions
): Promise<AgentRunContext> {
  const config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  const item = db
    .select()
    .from(workflowItems)
    .where(
      and(
        eq(workflowItems.workspaceId, options.workspaceId),
        eq(workflowItems.id, options.workflowItemId)
      )
    )
    .all()[0];
  if (!item) {
    throw errors.precondition('The run references a work item that no longer exists');
  }
  const record = db
    .select()
    .from(records)
    .where(and(eq(records.workspaceId, options.workspaceId), eq(records.id, options.recordId)))
    .all()[0];
  if (!record) {
    throw errors.precondition('The run references a record that no longer exists');
  }
  const objectType = requireObjectType(db, options.workspaceId, record.objectTypeId);
  const contract = await buildRecordContract(
    db,
    options.workspaceId,
    record.objectTypeId,
    options.workflowId
  );
  const values = workflowItemFieldValuesByKey(db, options.workspaceId, item.id, record.id);

  const sections: string[] = [];
  const systemParts: string[] = [];

  systemParts.push(
    `You are ${options.agent.name}, an agent working inside Mentat. ` +
      `You are handling ${objectType.name} "${record.displayName}" in the state "${options.stateName}".`
  );
  if (options.agent.instructions.trim().length > 0) {
    systemParts.push(options.agent.instructions.trim());
  }
  if (options.extraInstructions && options.extraInstructions.trim().length > 0) {
    systemParts.push(options.extraInstructions.trim());
  }

  const skillInstructions = assembleSkillInstructions(
    db,
    options.workspaceId,
    options.agent.skillIds ?? []
  );
  if (skillInstructions.length > 0) {
    systemParts.push(
      skillInstructions
        .map((skill) => `## Skill: ${skill.name} (v${skill.version})\n${skill.instructions}`)
        .join('\n\n')
    );
    sections.push('skills');
  }

  if (options.requiredSubmission) {
    const toolKey = options.requiredSubmission.toolKey ?? 'workflowItems.submit';
    const workflowRule =
      options.requiredSubmission.allowWorkflowChange === false
        ? 'Do not set workflow.workflowId: this state keeps the work in its current workflow.'
        : 'If the work belongs in a different workflow, set workflow.workflowId — the record must then match that workflow.';
    systemParts.push(
      `You must finish by calling the \`${toolKey}\` tool exactly once.\n` +
        '- `record`: the complete record field values, validated against the schema below.\n' +
        '- `workflow`: the next step, either `{ stateId }` or `{ transitionId }`, with an optional `reason` and `note`.\n' +
        workflowRule
    );
  }

  systemParts.push(
    'Use the provided tools to inspect and change work. Only call tools you have ' +
      'been given. Never invent ids or field keys. A submission that does not match ' +
      'the record contract is rejected with field issues and must be corrected.'
  );

  const userParts: string[] = [];
  userParts.push(
    `# ${objectType.name} ${record.displayName}` +
      (record.key ? ` (${record.key})` : '') +
      `\nObject Type: ${objectType.key}`
  );

  const fieldLines = contract.fields.map((field) => {
    const value = values[field.key];
    const requirement = field.required ? 'required' : 'optional';
    const provenance = field.source === 'workflow' ? ', workflow overlay' : '';
    return `- ${field.name} (${field.key}): ${renderValue(value)} [${field.type}, ${requirement}${provenance}]`;
  });
  if (fieldLines.length > 0) {
    userParts.push(`## Record fields\n${fieldLines.join('\n')}`);
    sections.push('fields');
  }

  if (config.includeRecordSchema !== false) {
    userParts.push(`## Record contract\n${describeRecordContract(contract)}`);
    sections.push('record_contract');
  }

  const noteLimit = config.includeRecentNotes ?? 5;
  if (noteLimit > 0) {
    const durable = db
      .select()
      .from(recordNotes)
      .where(
        and(
          eq(recordNotes.workspaceId, options.workspaceId),
          eq(recordNotes.recordId, record.id),
          isNull(recordNotes.deletedAt)
        )
      )
      .orderBy(desc(recordNotes.createdAt))
      .limit(noteLimit)
      .all()
      .reverse();
    const work = db
      .select()
      .from(workflowItemNotes)
      .where(
        and(
          eq(workflowItemNotes.workspaceId, options.workspaceId),
          eq(workflowItemNotes.workflowItemId, item.id),
          isNull(workflowItemNotes.deletedAt)
        )
      )
      .orderBy(desc(workflowItemNotes.createdAt))
      .limit(noteLimit)
      .all()
      .reverse();
    if (durable.length > 0) {
      userParts.push(
        `## Record notes\n${durable.map((note) => `- [${note.authorLabel ?? note.authorType}] ${note.body}`).join('\n')}`
      );
      sections.push('record_notes');
    }
    if (work.length > 0) {
      userParts.push(
        `## Work notes\n${work.map((note) => `- [${note.authorLabel ?? note.authorType}] ${note.body}`).join('\n')}`
      );
      sections.push('work_notes');
    }
  }

  if (config.includeStateHistory) {
    const history = db
      .select()
      .from(workflowItemStateHistory)
      .where(
        and(
          eq(workflowItemStateHistory.workspaceId, options.workspaceId),
          eq(workflowItemStateHistory.workflowItemId, item.id)
        )
      )
      .orderBy(asc(workflowItemStateHistory.enteredAt))
      .all();
    if (history.length > 0) {
      userParts.push(
        `## State history\n${history
          .map(
            (entry) =>
              `- ${entry.stateName}: entered ${new Date(entry.enteredAt).toISOString()}` +
              (entry.exitedAt ? `, left ${new Date(entry.exitedAt).toISOString()}` : ' (current)')
          )
          .join('\n')}`
      );
      sections.push('state_history');
    }
  }

  if (config.includeFileSummaries !== false) {
    const linked = db
      .select({ link: fileWorkflowItems, file: files })
      .from(fileWorkflowItems)
      .innerJoin(files, eq(files.id, fileWorkflowItems.fileId))
      .where(
        and(
          eq(fileWorkflowItems.workspaceId, options.workspaceId),
          eq(fileWorkflowItems.workflowItemId, item.id),
          isNull(fileWorkflowItems.removedAt),
          isNull(files.deletedAt)
        )
      )
      .all();
    if (linked.length > 0) {
      userParts.push(
        `## Linked files\n${linked
          .map((entry) =>
            entry.file.summary
              ? `- ${entry.file.originalFilename}: ${entry.file.summary}`
              : `- ${entry.file.originalFilename} (${entry.file.mimeType})`
          )
          .join('\n')}`
      );
      sections.push('files');
    }
  }

  const redactor = createRedactor(registeredSecretValues());
  const system = redactor.string(systemParts.join('\n\n'));
  const user = redactor.string(userParts.join('\n\n'));
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    snapshot: {
      sections,
      recordId: record.id,
      workflowItemId: item.id,
      objectTypeId: objectType.id,
      state: options.stateName,
      messageCount: 2,
      system,
      user,
      contextConfig: config
    },
    sections
  };
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
