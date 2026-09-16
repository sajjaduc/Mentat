/**
 * Agent context assembly.
 *
 * The plan is explicit that not every note, field and document should be injected
 * into every model call (§30 context control, follow-up §18). Assembly is driven
 * by the *state's* `AgentContextConfig`, so a state can request exactly the
 * ticket fields, recent notes, linked-file summaries and selected file fields it
 * needs — and nothing else.
 *
 * Secrets are never candidates for inclusion: this module only reads ticket
 * fields, notes, file summaries and history. Environment variables and secret
 * values are resolved separately, inside execution, and are never rendered into a
 * prompt.
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { assembleSkillInstructions } from '../agents/service';
import { createRedactor } from '../core/redaction';
import { registeredSecretValues } from '../core/secret-registry';
import type { Executor } from '../db/client';
import {
  type AgentContextConfig,
  type AgentSnapshot,
  fieldDefinitions,
  fileExtractedContent,
  fileFieldValues,
  files,
  type Ticket,
  ticketFiles,
  ticketNotes,
  ticketStateHistory
} from '../db/schema';
import type { ChatMessage } from '../providers/types';
import { fieldValuesByKey } from '../tickets/values';

export interface AgentRunContext {
  messages: ChatMessage[];
  /** Redacted snapshot persisted on the run for inspection. */
  snapshot: Record<string, unknown>;
  sections: string[];
}

export interface BuildContextOptions {
  workspaceId: string;
  ticket: Ticket;
  workflowId: string;
  stateId: string;
  stateName: string;
  agent: AgentSnapshot;
  config: AgentContextConfig | null;
  /** Extra operator guidance appended to the system prompt (for example a gate note). */
  extraInstructions?: string | null;
  /** Cap for extracted content, in characters. */
  maxFileContentChars?: number;
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

export async function buildAgentRunContext(
  db: Executor,
  options: BuildContextOptions
): Promise<AgentRunContext> {
  const config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  const sections: string[] = [];
  const systemParts: string[] = [];

  systemParts.push(
    `You are ${options.agent.name}, an agent working inside Mentat. ` +
      `You are handling ticket ${options.ticket.key} in the state "${options.stateName}".`
  );
  if (options.agent.instructions.trim().length > 0) {
    systemParts.push(options.agent.instructions.trim());
  }
  if (options.extraInstructions && options.extraInstructions.trim().length > 0) {
    systemParts.push(options.extraInstructions.trim());
  }

  // Skills are instructions, not executable plugins.
  const skillInstructions = assembleSkillInstructions(
    db,
    options.workspaceId,
    options.agent.skillIds ?? []
  );
  if (skillInstructions.length > 0) {
    const rendered = skillInstructions
      .map((skill) => `## Skill: ${skill.name} (v${skill.version})\n${skill.instructions}`)
      .join('\n\n');
    systemParts.push(rendered);
    sections.push('skills');
  }

  systemParts.push(
    'Use the provided tools to inspect and change work. Only call tools you have ' +
      'been given. Never invent ticket ids, field keys or state ids. When you are ' +
      'finished, state the outcome plainly.'
  );

  const userParts: string[] = [];

  if (config.includeTitle !== false) {
    userParts.push(`# Ticket ${options.ticket.key}\n${options.ticket.title}`);
    sections.push('title');
  }
  if (config.includeDescription !== false && options.ticket.description) {
    userParts.push(`## Description\n${options.ticket.description}`);
    sections.push('description');
  }

  const contextFields = await selectedFields(
    db,
    options.workspaceId,
    options.ticket.id,
    config.fieldKeys ?? []
  );
  if (contextFields.length > 0) {
    userParts.push(
      `## Fields\n${contextFields.map((entry) => `- ${entry.name} (${entry.key}): ${renderValue(entry.value)}`).join('\n')}`
    );
    sections.push('fields');
  }

  if ((config.includeRecentNotes ?? 0) > 0) {
    const noteRows = db
      .select()
      .from(ticketNotes)
      .where(
        and(
          eq(ticketNotes.workspaceId, options.workspaceId),
          eq(ticketNotes.ticketId, options.ticket.id),
          isNull(ticketNotes.deletedAt)
        )
      )
      .orderBy(desc(ticketNotes.createdAt))
      .limit(config.includeRecentNotes ?? 0)
      .all();
    if (noteRows.length > 0) {
      const ordered = [...noteRows].reverse();
      userParts.push(
        `## Recent notes\n${ordered
          .map((note) => `- [${note.authorLabel ?? note.authorType}] ${note.body}`)
          .join('\n')}`
      );
      sections.push('notes');
    }
  }

  if (config.includeHistory) {
    const history = db
      .select({
        action: ticketStateHistory.stateName,
        enteredAt: ticketStateHistory.enteredAt,
        exitedAt: ticketStateHistory.exitedAt
      })
      .from(ticketStateHistory)
      .where(eq(ticketStateHistory.ticketId, options.ticket.id))
      .orderBy(asc(ticketStateHistory.enteredAt))
      .all();
    if (history.length > 0) {
      userParts.push(
        `## State history\n${history
          .map(
            (row) =>
              `- ${row.action} entered ${new Date(row.enteredAt).toISOString()}${
                row.exitedAt ? ` left ${new Date(row.exitedAt).toISOString()}` : ' (current)'
              }`
          )
          .join('\n')}`
      );
      sections.push('state_history');
    }
  }

  const fileContext = await selectedFileContext(
    db,
    options.workspaceId,
    options.ticket.id,
    config,
    {
      maxChars: options.maxFileContentChars ?? 8000
    }
  );
  if (fileContext.rendered) {
    userParts.push(fileContext.rendered);
    sections.push('files');
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemParts.join('\n\n') },
    { role: 'user', content: userParts.join('\n\n') }
  ];

  // Defence in depth: if any registered secret value somehow reached the context,
  // mask it before it can be sent to a provider or persisted.
  const redactor = createRedactor(registeredSecretValues());
  const redactedMessages = messages.map((message) => ({
    ...message,
    content: redactor.string(message.content)
  }));

  return {
    messages: redactedMessages,
    snapshot: {
      sections,
      ticketKey: options.ticket.key,
      state: options.stateName,
      messageCount: redactedMessages.length,
      // The snapshot stores the *redacted* prompt so an operator can audit what the
      // model saw without the snapshot itself becoming a leak vector.
      system: redactedMessages[0]?.content,
      user: redactedMessages[1]?.content,
      contextConfig: config
    },
    sections
  };
}

async function selectedFields(
  db: Executor,
  workspaceId: string,
  ticketId: string,
  fieldKeys: string[]
): Promise<Array<{ key: string; name: string; value: unknown }>> {
  if (fieldKeys.length === 0) return [];
  const definitions = db
    .select()
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, workspaceId),
        eq(fieldDefinitions.scope, 'ticket'),
        inArray(fieldDefinitions.key, fieldKeys)
      )
    )
    .all();
  if (definitions.length === 0) return [];
  const values = fieldValuesByKey(db, workspaceId, ticketId);
  return definitions
    .filter((definition) => values[definition.key] !== undefined)
    .map((definition) => ({
      key: definition.key,
      name: definition.name,
      value: values[definition.key]
    }));
}

async function selectedFileContext(
  db: Executor,
  workspaceId: string,
  ticketId: string,
  config: AgentContextConfig,
  options: { maxChars: number }
): Promise<{ rendered: string | null }> {
  const wantsSummaries = config.includeFileSummaries ?? false;
  const wantsFields = (config.includeFileFields ?? []).length > 0;
  const wantsContent = config.includeFullFileContent ?? false;
  if (!wantsSummaries && !wantsFields && !wantsContent) return { rendered: null };

  const links = db
    .select({
      id: files.id,
      filename: files.originalFilename,
      mimeType: files.mimeType,
      summary: files.summary,
      status: files.status
    })
    .from(ticketFiles)
    .innerJoin(files, eq(files.id, ticketFiles.fileId))
    .where(
      and(
        eq(ticketFiles.workspaceId, workspaceId),
        eq(ticketFiles.ticketId, ticketId),
        isNull(ticketFiles.removedAt),
        isNull(files.deletedAt)
      )
    )
    .all();
  if (links.length === 0) return { rendered: null };

  const fileIds = links.map((link) => link.id);
  const fieldValues = wantsFields
    ? db
        .select({
          fileId: fileFieldValues.fileId,
          definition: fieldDefinitions,
          value: fileFieldValues
        })
        .from(fileFieldValues)
        .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fileFieldValues.fieldDefinitionId))
        .where(
          and(
            eq(fileFieldValues.workspaceId, workspaceId),
            inArray(fileFieldValues.fileId, fileIds),
            inArray(fieldDefinitions.key, config.includeFileFields ?? [])
          )
        )
        .all()
    : [];

  const contents = wantsContent
    ? db
        .select({
          fileId: fileExtractedContent.fileId,
          text: fileExtractedContent.text,
          createdAt: fileExtractedContent.createdAt
        })
        .from(fileExtractedContent)
        .where(
          and(
            eq(fileExtractedContent.workspaceId, workspaceId),
            inArray(fileExtractedContent.fileId, fileIds)
          )
        )
        .orderBy(desc(fileExtractedContent.createdAt))
        .all()
    : [];
  const contentByFile = new Map<string, { text: string; createdAt: number }>();
  for (const row of contents) {
    if (!contentByFile.has(row.fileId)) {
      contentByFile.set(row.fileId, { text: row.text, createdAt: row.createdAt });
    }
  }

  const lines: string[] = ['## Linked files'];
  for (const link of links) {
    const parts = [`- ${link.filename} (${link.mimeType}, ${link.status})`];
    if (wantsSummaries && link.summary) parts.push(`  Summary: ${link.summary}`);
    for (const field of fieldValues.filter((entry) => entry.fileId === link.id)) {
      parts.push(
        `  ${field.definition.name}: ${renderValue(
          field.value.valueText ??
            field.value.valueNumber ??
            field.value.valueBool ??
            field.value.valueDate ??
            field.value.valueJson
        )}`
      );
    }
    if (wantsContent) {
      const content = contentByFile.get(link.id);
      if (content) {
        const text =
          content.text.length > options.maxChars
            ? `${content.text.slice(0, options.maxChars)}\n…[truncated]`
            : content.text;
        parts.push(`  Content:\n${indent(text, '    ')}`);
      }
    }
    lines.push(parts.join('\n'));
  }

  return { rendered: lines.join('\n') };
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
