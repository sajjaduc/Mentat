/**
 * Agent runner.
 *
 * The runner is the durable heart of Mentat. Its central property is that it has
 * **no in-memory state that matters**: everything needed to continue a run is
 * persisted in `agent_runs`, `agent_run_steps` and `approval_requests`. Recovery
 * after a worker crash, resumption after an approval, and normal forward progress
 * all take the same code path ("reconcile what is missing, then continue"), which
 * is why those behaviours are covered by the same tests.
 *
 * Ordering rules:
 *  - run state transitions are persisted before anything observable is streamed;
 *  - tool execution happens outside transactions, and its result is persisted in a
 *    following transaction;
 *  - provider generation is wrapped in retry/backoff and streams into `run_events`.
 */
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { agentPermissionsToSet } from '../agents/permissions';
import { requireAgent, requireAgentVersion } from '../agents/service';
import { AuditActions, writeAudit } from '../audit/ledger';
import { backoffDelayMs } from '../core/clock';
import { type ActorContext, agentActor, withRun } from '../core/context';
import { errors, toAppError } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { moduleLogger } from '../core/logger';
import { createRedactor } from '../core/redaction';
import { registeredSecretValues } from '../core/secret-registry';
import { type Executor, getDb } from '../db/client';
import {
  type AgentPermissions,
  type AgentRun,
  type AgentRunStep,
  type AgentSnapshot,
  agentRunSteps,
  agentRuns,
  agents,
  agentVersions,
  approvalRequests,
  records,
  type Tool,
  tools,
  type WorkflowState,
  workflowItems,
  workflowStates
} from '../db/schema';
import {
  type ReasoningEffort,
  reasoningSettingFrom,
  resolveReasoning,
  supportedReasoningEfforts
} from '../providers/reasoning';
import type {
  ChatMessage,
  GenerateRequest,
  ProviderModelCapabilities,
  ToolCallRequest,
  ToolDefinitionForModel
} from '../providers/types';
import { type InvokeToolResult, invokeTool } from '../tools/invoke';
import { toolRegistry as defaultToolRegistry } from '../tools/registry';
import { buildRecordRunContext } from './context';
import { publishRunEvent, RunEventTypes } from './events';
import { resolveProviderForModel } from './provider-lookup';

const log = moduleLogger('execution.runner');

export type RunOutcomeStatus = 'succeeded' | 'failed' | 'awaiting_approval' | 'cancelled';

export interface RunOutcome {
  status: RunOutcomeStatus;
  runId: string;
  output?: unknown;
  error?: string;
  approvalId?: string;
  steps: number;
}

export interface StartRunInput {
  workspaceId: string;
  /** Universal-model subject: a WorkflowItem participation and its Record. */
  workflowItemId?: string | null;
  recordId?: string | null;
  state: WorkflowState;
  agentId: string;
  triggerType: AgentRun['triggerType'];
  triggerId?: string | null;
  jobId?: string | null;
  attempt?: number;
}

export interface RunExecutionContext {
  jobId?: string | null;
  workerId?: string;
  signal?: AbortSignal;
  heartbeat?: (extraSeconds?: number) => Promise<void>;
  /** Resume a paused run: approvals already decided are applied first. */
  resumeApprovalId?: string | null;
}

/** Create the run row. Called inside the state-entry transaction. */
export function createAgentRunSync(tx: Executor, input: StartRunInput): AgentRun {
  const agent = requireAgent(tx, input.workspaceId, input.agentId);
  const { version, snapshot } = requireAgentVersion(tx, input.workspaceId, agent);
  const now = Date.now();

  const run = tx
    .insert(agentRuns)
    .values({
      id: uuidv7(now),
      workspaceId: input.workspaceId,
      recordId: input.recordId ?? null,
      workflowItemId: input.workflowItemId ?? null,
      workflowId: input.state.workflowId,
      stateId: input.state.id,
      agentId: agent.id,
      agentVersionId: agent.currentVersionId ?? '',
      agentVersion: version,
      providerId: snapshot.providerId ?? null,
      providerType: snapshot.providerType ?? null,
      modelId: snapshot.modelId ?? null,
      modelKey: snapshot.modelKey ?? null,
      status: 'queued',
      attempt: input.attempt ?? 1,
      jobId: input.jobId ?? null,
      triggerType: input.triggerType,
      triggerId: input.triggerId ?? null,
      contextConfig: (input.state.config?.context as never) ?? null,
      promptVersion: 'v1',
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all()[0];
  if (!run) throw errors.internal('Failed to create agent run');

  writeAudit(tx, {
    workspaceId: input.workspaceId,
    action: AuditActions.agentRunStarted,
    actorType: 'agent',
    actorId: agent.id,
    actorLabel: agent.name,
    entityType: 'agent_run',
    entityId: run.id,
    recordId: input.recordId ?? null,
    workflowItemId: input.workflowItemId ?? null,
    workflowId: input.state.workflowId,
    runId: run.id,
    summary: `${agent.name} started on ${runSubjectLabel(input)} (version ${version})`,
    data: {
      agentVersion: version,
      modelId: snapshot.modelId,
      stateId: input.state.id,
      triggerType: input.triggerType
    },
    occurredAt: now
  });

  publishRunEvent(
    tx,
    {
      workspaceId: input.workspaceId,
      runId: run.id,
      recordId: input.recordId ?? null,
      workflowItemId: input.workflowItemId ?? null,
      type: RunEventTypes.runQueued,
      data: { runId: run.id, agentId: agent.id, agentName: agent.name, agentVersion: version }
    },
    now
  );

  return run;
}

function runSubjectLabel(input: StartRunInput): string {
  return input.recordId ?? input.workflowItemId ?? 'work';
}

function buildAgentActor(
  workspaceId: string,
  agent: AgentSnapshot,
  runId: string,
  label: string
): ActorContext {
  const permissions = agentPermissionsToSet(agent.permissions as AgentPermissions | null);
  return agentActor(workspaceId, agent.id, label, permissions, { runId });
}

/**
 * Execute (or continue) a run.
 *
 * `executeAgentRun` is idempotent with respect to already-persisted steps: calling
 * it twice for the same run continues rather than duplicating work. That is what
 * makes lease expiry, retries and process restarts safe.
 */
export async function executeAgentRun(
  db: Executor,
  runId: string,
  context: RunExecutionContext = {}
): Promise<RunOutcome> {
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1).all()[0];
  if (!run) throw errors.notFound('Agent run', runId);
  if (run.status === 'succeeded' || run.status === 'cancelled') {
    return { status: run.status === 'succeeded' ? 'succeeded' : 'cancelled', runId, steps: 0 };
  }

  const workspaceId = run.workspaceId;
  const agent = requireAgent(db, workspaceId, run.agentId);
  const { snapshot } = requireAgentVersion(db, workspaceId, agent, run.agentVersionId || null);
  const workflowItem = run.workflowItemId
    ? (db
        .select()
        .from(workflowItems)
        .where(
          and(eq(workflowItems.workspaceId, workspaceId), eq(workflowItems.id, run.workflowItemId))
        )
        .limit(1)
        .all()[0] ?? null)
    : null;
  const record = run.recordId
    ? (db
        .select()
        .from(records)
        .where(and(eq(records.workspaceId, workspaceId), eq(records.id, run.recordId)))
        .limit(1)
        .all()[0] ?? null)
    : null;
  const state = db
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.id, run.stateId))
    .limit(1)
    .all()[0];
  if (!state) throw errors.precondition('The run references a state that no longer exists');

  const actor = withRun(buildAgentActor(workspaceId, snapshot, runId, agent.name), runId);
  const executionConfig = (snapshot.executionConfig ?? {}) as {
    maxSteps?: number;
    timeoutSeconds?: number;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    reasoningEffort?: ReasoningEffort;
    reasoningOptions?: Record<string, unknown>;
    continueOnToolError?: boolean;
    retryOnProviderError?: boolean;
    requireApprovalForMutations?: boolean;
  };
  const maxSteps = executionConfig.maxSteps ?? 12;

  // Mark running before doing anything observable.
  markRunStatus(db, run, 'running', { startedAt: run.startedAt ?? Date.now() });

  if (!snapshot.modelId) {
    const failure = errors.precondition(
      `Agent "${agent.name}" has no model configured. Choose a model before running it.`
    );
    failRun(db, run, failure);
    return { status: 'failed', runId, error: failure.message, steps: 0 };
  }

  let resolved: Awaited<ReturnType<typeof resolveProviderForModel>>;
  try {
    resolved = await resolveProviderForModel(db, {
      workspaceId,
      modelId: snapshot.modelId
    });
  } catch (error) {
    const appError = toAppError(error);
    failRun(db, run, appError);
    return { status: 'failed', runId, error: appError.message, steps: 0 };
  }

  const declared = resolved.model.capabilities ?? {};
  const capabilities: ProviderModelCapabilities = {
    streaming: declared.streaming ?? false,
    toolCalling: declared.toolCalling ?? false,
    jsonMode: declared.jsonMode ?? false,
    vision: declared.vision ?? false,
    embeddings: declared.embeddings ?? false,
    reasoning: declared.reasoning,
    reasoningEfforts: declared.reasoningEfforts
  };

  // Reasoning is opt-in per model capability. A configured level the model does not
  // accept is dropped (falling back to the next source that is accepted) and
  // reported on the run rather than failing it.
  const reasoning = resolveReasoning({
    supported: supportedReasoningEfforts(capabilities, resolved.provider.type),
    agent: reasoningSettingFrom(executionConfig),
    model: reasoningSettingFrom(resolved.model.inferenceDefaults)
  });
  if (reasoning.warning) {
    log.warn('reasoning setting ignored', { runId, warning: reasoning.warning });
    publishRunEvent(db, {
      workspaceId,
      runId,
      recordId: run.recordId,
      workflowItemId: run.workflowItemId,
      type: RunEventTypes.runWarning,
      data: { kind: 'reasoning', message: reasoning.warning }
    });
  }

  // Rebuild the conversation from persisted steps. This is the recovery path *and*
  // the resume path: both are just "look at what is already durable".
  let steps = loadSteps(db, runId);
  let messages: ChatMessage[];
  if (steps.length === 0) {
    const built =
      workflowItem && record
        ? await buildRecordRunContext(db, {
            workspaceId,
            workflowItemId: workflowItem.id,
            recordId: record.id,
            workflowId: run.workflowId,
            stateId: state.id,
            stateName: state.name,
            agent: snapshot,
            config: state.config?.context ?? null,
            requiredSubmission: state.config?.requiredSubmission ?? null
          })
        : missingSubject(workspaceId, run);
    messages = built.messages;
    persistStep(db, {
      workspaceId,
      runId,
      index: 0,
      type: 'context',
      name: 'context',
      status: 'completed',
      output: built.snapshot,
      metadata: { sections: built.sections }
    });
    steps = loadSteps(db, runId);
  } else {
    const rebuilt = await rebuildMessages(db, run, state, snapshot, steps);
    messages = rebuilt;
  }

  const toolDescriptors = resolveToolDescriptors(db, workspaceId, snapshot);

  let stepIndex = steps.reduce((max, step) => Math.max(max, step.index), 0);
  let executedSteps = 0;

  // ---- Reconcile: complete any tool calls that were persisted without a result.
  const reconcile = await reconcilePendingToolCalls(db, {
    run,
    actor,
    snapshot,
    toolDescriptors,
    messages,
    workspaceId,
    stepIndex,
    executionConfig,
    context
  });
  if (reconcile.status === 'awaiting_approval') {
    return {
      status: 'awaiting_approval',
      runId,
      approvalId: reconcile.approvalId,
      steps: reconcile.steps
    };
  }
  messages = reconcile.messages;
  stepIndex = reconcile.stepIndex;
  executedSteps += reconcile.steps;

  // ---- Main loop
  for (let iteration = 0; iteration < maxSteps; iteration++) {
    if (context.signal?.aborted) {
      cancelRun(db, run, 'Run cancelled');
      return { status: 'cancelled', runId, steps: executedSteps };
    }
    await context.heartbeat?.();

    let generation: {
      content: string;
      toolCalls: ToolCallRequest[];
      finishReason: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    };
    try {
      generation = await generateWithRetry({
        provider: resolved.provider,
        capabilities,
        request: {
          model: resolved.model.modelKey,
          messages,
          tools:
            capabilities.toolCalling && toolDescriptors.length > 0
              ? toolDescriptors.map(toModelTool)
              : undefined,
          jsonSchema: capabilities.jsonMode
            ? ((snapshot.outputSchema as Record<string, unknown> | null) ?? undefined)
            : undefined,
          temperature: executionConfig.temperature,
          topP: executionConfig.topP,
          maxOutputTokens: executionConfig.maxOutputTokens,
          reasoningEffort: reasoning.effort,
          reasoningOptions:
            Object.keys(reasoning.options).length > 0 ? reasoning.options : undefined,
          signal: context.signal,
          timeoutMs: (executionConfig.timeoutSeconds ?? 300) * 1000
        },
        run,
        retryOnProviderError: executionConfig.retryOnProviderError ?? true,
        onDelta: (delta) => {
          publishRunEvent(db, {
            workspaceId,
            runId,
            recordId: run.recordId,
            workflowItemId: run.workflowItemId,
            type: RunEventTypes.runDelta,
            data: { content: delta }
          });
        },
        onReasoning: (delta) => {
          publishRunEvent(db, {
            workspaceId,
            runId,
            recordId: run.recordId,
            workflowItemId: run.workflowItemId,
            type: RunEventTypes.runReasoning,
            data: { content: delta }
          });
        }
      });
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code === 'human_gate_required' || appError.code === 'approval_required') {
        // Not a failure: the run is intentionally paused.
        markRunStatus(db, run, 'awaiting_approval');
        return { status: 'awaiting_approval', runId, steps: executedSteps };
      }
      failRun(db, run, appError);
      return { status: 'failed', runId, error: appError.message, steps: executedSteps };
    }

    stepIndex += 1;
    const assistantStep = persistStep(db, {
      workspaceId,
      runId,
      index: stepIndex,
      type: 'message',
      name: 'assistant',
      status: 'completed',
      output: {
        content: generation.content,
        toolCalls: generation.toolCalls,
        finishReason: generation.finishReason
      },
      metadata: { usage: generation.usage }
    });
    executedSteps += 1;

    messages = [
      ...messages,
      {
        role: 'assistant',
        content: generation.content,
        toolCalls: generation.toolCalls.length > 0 ? generation.toolCalls : undefined
      }
    ];

    if (generation.toolCalls.length === 0) {
      // A state may enforce a structured record submission (ADR-0023): the model
      // must have called the contract tool successfully before the run can end.
      const required = state.config?.requiredSubmission;
      if (required) {
        const toolKey = required.toolKey ?? 'workflowItems.submit';
        if (!submissionSatisfied(db, runId, toolKey)) {
          const maxNudges = required.maxNudges ?? 2;
          const nudges = countSteps(db, runId, 'contract.nudge');
          if (nudges < maxNudges) {
            const reminder =
              `You have not submitted the required result. Call the \`${toolKey}\` tool now with the ` +
              'validated record fields and the workflow directive, then finish.';
            stepIndex += 1;
            persistStep(db, {
              workspaceId,
              runId,
              index: stepIndex,
              type: 'thought',
              name: 'contract.nudge',
              status: 'completed',
              output: { content: reminder }
            });
            publishRunEvent(db, {
              workspaceId,
              runId,
              recordId: run.recordId,
              workflowItemId: run.workflowItemId,
              type: RunEventTypes.runWarning,
              data: { kind: 'required_submission', message: reminder, nudge: nudges + 1 }
            });
            messages = [...messages, { role: 'user', content: reminder }];
            continue;
          }
          const failure = errors.precondition(
            `The run finished without a valid ${toolKey} submission`
          );
          failRun(db, run, failure);
          return { status: 'failed', runId, error: failure.message, steps: executedSteps };
        }
      }
      // Terminal: the model produced a final answer.
      const output = parseRunOutput(generation.content, snapshot.outputSchema);
      succeedRun(db, run, {
        output,
        outputText: generation.content,
        usage: generation.usage,
        stepId: assistantStep
      });
      return { status: 'succeeded', runId, output, steps: executedSteps };
    }

    for (const toolCall of generation.toolCalls) {
      const descriptor = toolDescriptors.find((tool) => tool.key === toolCall.name);
      if (!descriptor) {
        stepIndex += 1;
        persistStep(db, {
          workspaceId,
          runId,
          index: stepIndex,
          type: 'tool_result',
          name: toolCall.name,
          status: 'failed',
          output: { error: 'unknown_tool' },
          error: `No tool named "${toolCall.name}" is available to this agent`,
          metadata: { toolCallId: toolCall.id }
        });
        executedSteps += 1;
        messages = [
          ...messages,
          {
            role: 'tool',
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({
              ok: false,
              error: { code: 'unknown_tool', message: `No tool named "${toolCall.name}"` }
            })
          }
        ];
        continue;
      }

      const callIndex = stepIndex + 1;
      stepIndex = callIndex;
      persistStep(db, {
        workspaceId,
        runId,
        index: callIndex,
        type: 'tool_call',
        name: toolCall.name,
        status: 'started',
        input: toolCall.arguments,
        toolId: descriptor.toolId,
        toolKey: toolCall.name,
        metadata: { toolCallId: toolCall.id }
      });
      executedSteps += 1;

      writeAudit(db, {
        workspaceId,
        action: AuditActions.toolCallStarted,
        actorType: 'agent',
        actorId: run.agentId,
        actorLabel: agent.name,
        entityType: 'agent_run',
        entityId: run.id,
        recordId: run.recordId,
        workflowItemId: run.workflowItemId,
        workflowId: run.workflowId,
        runId,
        summary: `Tool call started: ${toolCall.name}`,
        data: { toolKey: toolCall.name, arguments: toolCall.arguments }
      });

      // Approval policy is evaluated by Mentat, never by the model.
      const approval = evaluateApprovalPolicy(descriptor, toolCall, executionConfig);
      if (approval.required) {
        const decision = existingApproval(db, run.id, toolCall.id);
        if (!decision) {
          const created = requestToolApproval(db, {
            run,
            actor,
            toolCall,
            descriptor,
            reason: approval.reason
          });
          markRunStatus(db, run, 'awaiting_approval');
          return {
            status: 'awaiting_approval',
            runId,
            approvalId: created.id,
            steps: executedSteps
          };
        }
        if (decision.status === 'pending') {
          markRunStatus(db, run, 'awaiting_approval');
          return {
            status: 'awaiting_approval',
            runId,
            approvalId: decision.id,
            steps: executedSteps
          };
        }
        if (decision.status !== 'approved') {
          // Rejected: tell the model and let it choose another path.
          const rejection = {
            ok: false,
            error: {
              code: 'rejected',
              message: `A human rejected this action${decision.decisionComment ? `: ${decision.decisionComment}` : ''}`
            }
          };
          stepIndex += 1;
          persistStep(db, {
            workspaceId,
            runId,
            index: stepIndex,
            type: 'tool_result',
            name: toolCall.name,
            status: 'failed',
            output: rejection,
            error: 'rejected_by_reviewer',
            toolId: descriptor.toolId,
            toolKey: toolCall.name,
            metadata: { toolCallId: toolCall.id, approvalId: decision.id }
          });
          executedSteps += 1;
          messages = [
            ...messages,
            {
              role: 'tool',
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify(rejection)
            }
          ];
          continue;
        }
      }

      const result = await runTool(db, {
        actor,
        descriptor,
        toolCall,
        workspaceId,
        runId,
        recordId: run.recordId,
        workflowItemId: run.workflowItemId,
        workflowId: run.workflowId,
        stepId: callIndex.toString()
      });

      stepIndex += 1;
      persistStep(db, {
        workspaceId,
        runId,
        index: stepIndex,
        type: 'tool_result',
        name: toolCall.name,
        status: result.ok ? 'completed' : 'failed',
        output: result.output,
        error: result.error?.message ?? null,
        toolId: descriptor.toolId,
        toolKey: toolCall.name,
        metadata: {
          toolCallId: toolCall.id,
          cacheStatus: result.cacheStatus,
          durationMs: result.durationMs,
          ...(result.metadata ?? {})
        }
      });
      executedSteps += 1;

      // The ledger records tool calls explicitly: "which agent called what, and did
      // it work" is one of the questions the audit trail exists to answer.
      writeAudit(db, {
        workspaceId,
        action: result.ok ? AuditActions.toolCallCompleted : AuditActions.toolCallFailed,
        actorType: 'agent',
        actorId: run.agentId,
        actorLabel: agent.name,
        entityType: 'agent_run',
        entityId: run.id,
        recordId: run.recordId,
        workflowItemId: run.workflowItemId,
        workflowId: run.workflowId,
        runId,
        summary: `${result.ok ? 'Tool call' : 'Tool call failed'}: ${toolCall.name}`,
        data: {
          toolKey: toolCall.name,
          ok: result.ok,
          durationMs: result.durationMs,
          cacheStatus: result.cacheStatus ?? null,
          error: result.error?.message ?? null
        }
      });

      publishRunEvent(db, {
        workspaceId,
        runId,
        recordId: run.recordId,
        workflowItemId: run.workflowItemId,
        type: result.ok ? RunEventTypes.toolCompleted : RunEventTypes.toolFailed,
        data: {
          toolKey: toolCall.name,
          ok: result.ok,
          error: result.error?.message,
          durationMs: result.durationMs
        }
      });

      messages = [
        ...messages,
        {
          role: 'tool',
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify(result.ok ? result.output : { ok: false, error: result.error })
        }
      ];

      if (!result.ok && !(executionConfig.continueOnToolError ?? true)) {
        const failure = errors.dependency(
          `Tool "${toolCall.name}" failed: ${result.error?.message}`
        );
        failRun(db, run, failure);
        return { status: 'failed', runId, error: failure.message, steps: executedSteps };
      }
    }
  }

  const exhausted = errors.precondition(
    `The agent reached its ${maxSteps}-step limit without finishing. Raise maxSteps or tighten the instructions.`,
    { maxSteps }
  );
  failRun(db, run, exhausted);
  return { status: 'failed', runId, error: exhausted.message, steps: executedSteps };
}

function missingSubject(workspaceId: string, run: AgentRun): never {
  throw errors.precondition('Agent runs require a workflow item and record', {
    workspaceId,
    runId: run.id
  });
}

/** True when the run already holds a completed result for `toolKey`. */
function submissionSatisfied(db: Executor, runId: string, toolKey: string): boolean {
  return loadSteps(db, runId).some(
    (step) => step.type === 'tool_result' && step.name === toolKey && step.status === 'completed'
  );
}

function countSteps(db: Executor, runId: string, name: string): number {
  return loadSteps(db, runId).filter((step) => step.name === name).length;
}

// ---------------------------------------------------------------------------
// Provider interaction
// ---------------------------------------------------------------------------

async function generateWithRetry(options: {
  provider: Awaited<ReturnType<typeof resolveProviderForModel>>['provider'];
  capabilities: ProviderModelCapabilities;
  request: GenerateRequest;
  run: AgentRun;
  retryOnProviderError: boolean;
  onDelta: (delta: string) => void;
  onReasoning: (delta: string) => void;
  maxAttempts?: number;
}): Promise<{
  content: string;
  toolCalls: ToolCallRequest[];
  finishReason: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}> {
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (options.capabilities.streaming && options.provider.stream) {
        let content = '';
        let toolCalls: ToolCallRequest[] = [];
        let finishReason = 'stop';
        let usage:
          | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
          | undefined;

        for await (const event of options.provider.stream(options.request)) {
          switch (event.type) {
            case 'delta':
              content += event.content;
              options.onDelta(event.content);
              break;
            case 'reasoning':
              options.onReasoning(event.content);
              break;
            case 'tool_calls':
              toolCalls = event.toolCalls;
              break;
            case 'usage':
              usage = event.usage;
              break;
            case 'done':
              finishReason = event.finishReason;
              break;
            case 'error':
              throw errors.provider(event.message, { code: event.code });
            default:
              break;
          }
        }
        return { content, toolCalls, finishReason, usage };
      }

      const result = await options.provider.generate(options.request);
      if (result.content.length > 0) options.onDelta(result.content);
      return {
        content: result.content,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
        usage: result.usage
      };
    } catch (error) {
      lastError = error;
      const appError = toAppError(error);
      const retryable = appError.retryable || appError.code === 'provider_error';
      if (!retryable || !options.retryOnProviderError || attempt === maxAttempts) break;
      const delay = backoffDelayMs(attempt, { baseMs: 500, maxMs: 8000 });
      log.warn('provider call failed; retrying', {
        runId: options.run.id,
        attempt,
        delay,
        error: appError.message
      });
      publishRunEvent(getDb(), {
        workspaceId: options.run.workspaceId,
        runId: options.run.id,
        recordId: options.run.recordId,
        workflowItemId: options.run.workflowItemId,
        type: RunEventTypes.retryScheduled,
        data: { attempt, delayMs: delay, reason: appError.code }
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw toAppError(lastError);
}

// ---------------------------------------------------------------------------
// Tool resolution and invocation
// ---------------------------------------------------------------------------

interface ToolDescriptor {
  toolId: string | null;
  key: string;
  name: string;
  description: string;
  kind: 'native' | 'http' | 'mcp';
  inputSchema: Record<string, unknown>;
  implementation: Tool['implementation'];
  approvalPolicy: Tool['approvalPolicy'];
  cachePolicy: Tool['cachePolicy'];
  permissions: string[];
  timeoutSeconds: number;
}

function toModelTool(descriptor: ToolDescriptor): ToolDefinitionForModel {
  return {
    name: descriptor.key,
    description: descriptor.description,
    parameters: descriptor.inputSchema
  };
}

export function resolveToolDescriptors(
  db: Executor,
  workspaceId: string,
  snapshot: AgentSnapshot
): ToolDescriptor[] {
  const toolIds = snapshot.toolIds ?? [];
  if (toolIds.length === 0) return [];
  const rows = db
    .select()
    .from(tools)
    .where(
      and(eq(tools.workspaceId, workspaceId), inArray(tools.id, toolIds), eq(tools.enabled, true))
    )
    .all();
  return rows.map((tool) => ({
    toolId: tool.id,
    key: tool.key,
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
    inputSchema: (tool.inputSchema as Record<string, unknown> | null) ?? {
      type: 'object',
      properties: {}
    },
    implementation: tool.implementation,
    approvalPolicy: tool.approvalPolicy,
    cachePolicy: tool.cachePolicy,
    permissions: (tool.permissions as string[] | null) ?? [],
    timeoutSeconds: tool.timeoutSeconds
  }));
}

function evaluateApprovalPolicy(
  descriptor: ToolDescriptor,
  toolCall: ToolCallRequest,
  executionConfig: { requireApprovalForMutations?: boolean }
): { required: boolean; reason?: string } {
  const policy = descriptor.approvalPolicy;
  if (policy?.mode === 'always') {
    return { required: true, reason: policy.reason ?? 'This action always requires approval' };
  }
  if (policy?.mode === 'conditional') {
    const condition = policy.condition ?? '';
    if (condition === 'mutating' && isMutatingCall(descriptor, toolCall)) {
      return { required: true, reason: policy.reason ?? 'Mutating actions require approval' };
    }
    if (
      condition.startsWith('operation:') &&
      descriptor.key === condition.slice('operation:'.length)
    ) {
      return { required: true, reason: policy.reason ?? 'This operation requires approval' };
    }
  }
  if (executionConfig.requireApprovalForMutations && isMutatingCall(descriptor, toolCall)) {
    return { required: true, reason: 'This agent requires approval for mutating actions' };
  }
  return { required: false };
}

function isMutatingCall(descriptor: ToolDescriptor, toolCall: ToolCallRequest): boolean {
  if (descriptor.kind === 'http' || descriptor.kind === 'mcp') {
    const method = (toolCall.arguments as { method?: unknown }).method;
    // The HTTP runtime derives the method from the operation and MCP decides mutation
    // on the server; treat both as potentially mutating unless proven read-only.
    void method;
    return true;
  }
  const readOnlyPrefixes = [
    'workflowItems.get',
    'workflowItems.search',
    'workflowItems.getFields',
    'records.get',
    'records.search',
    'records.getFields',
    'objectTypes.list',
    'mentat.state.get',
    'mentat.state.list',
    'mentat.data.get',
    'mentat.data.find',
    'mentat.cache.get',
    'files.get',
    'files.list',
    'files.find',
    'files.search',
    'files.read',
    'files.getSummary',
    'files.getFields'
  ];
  return !readOnlyPrefixes.some((prefix) => descriptor.key.startsWith(prefix));
}

async function runTool(
  db: Executor,
  options: {
    actor: ActorContext;
    descriptor: ToolDescriptor;
    toolCall: ToolCallRequest;
    workspaceId: string;
    runId: string;
    recordId: string | null;
    workflowItemId: string | null;
    workflowId: string | null;
    stepId: string | null;
  }
): Promise<InvokeToolResult> {
  publishRunEvent(db, {
    workspaceId: options.workspaceId,
    runId: options.runId,
    recordId: options.recordId,
    workflowItemId: options.workflowItemId,
    type: RunEventTypes.toolStarted,
    data: { toolKey: options.descriptor.key, arguments: options.toolCall.arguments }
  });

  const startedAt = Date.now();
  const result = await invokeTool(db, {
    key: options.descriptor.key,
    toolId: options.descriptor.toolId,
    kind: options.descriptor.kind,
    implementation: options.descriptor.implementation,
    input: options.toolCall.arguments,
    actor: options.actor,
    workspaceId: options.workspaceId,
    recordId: options.recordId,
    workflowItemId: options.workflowItemId,
    workflowId: options.workflowId,
    runId: options.runId,
    stepId: options.stepId,
    timeoutSeconds: options.descriptor.timeoutSeconds,
    permissions: options.descriptor.permissions,
    inputSchema: options.descriptor.inputSchema,
    registry: defaultToolRegistry()
  });
  return { ...result, durationMs: result.durationMs ?? Date.now() - startedAt };
}

// ---------------------------------------------------------------------------
// Approval helpers
// ---------------------------------------------------------------------------

function existingApproval(db: Executor, runId: string, toolCallId: string) {
  const rows = db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.runId, runId), eq(approvalRequests.status, 'pending')))
    .all();
  const direct = rows.find(
    (row) => (row.requestedAction as { toolCallId?: string }).toolCallId === toolCallId
  );
  if (direct) return direct;
  // Include decided approvals so a rejection is not re-requested in a loop.
  return db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.runId, runId))
    .all()
    .find((row) => (row.requestedAction as { toolCallId?: string }).toolCallId === toolCallId);
}

function requestToolApproval(
  db: Executor,
  input: {
    run: AgentRun;
    actor: ActorContext;
    toolCall: ToolCallRequest;
    descriptor: ToolDescriptor;
    reason?: string;
  }
) {
  const redactor = createRedactor(registeredSecretValues());
  const now = Date.now();
  const row = db
    .insert(approvalRequests)
    .values({
      id: uuidv7(now),
      workspaceId: input.run.workspaceId,
      recordId: input.run.recordId,
      workflowItemId: input.run.workflowItemId,
      workflowId: input.run.workflowId,
      runId: input.run.id,
      kind: 'tool_call',
      title: `Approve ${input.descriptor.name}`,
      description: input.reason ?? 'This tool call requires human approval before it runs.',
      requestedAction: redactor.value({
        toolKey: input.descriptor.key,
        toolCallId: input.toolCall.id,
        arguments: input.toolCall.arguments
      }) as never,
      contextSnapshot: redactor.value({
        recordId: input.run.recordId,
        workflowItemId: input.run.workflowItemId,
        agentId: input.run.agentId
      }) as never,
      requestedByType: 'agent',
      requestedById: input.run.agentId,
      requestedByLabel: 'Agent',
      status: 'pending',
      createdAt: now
    })
    .returning()
    .all()[0];
  if (!row) throw errors.internal('Failed to create tool approval');

  writeAudit(db, {
    workspaceId: input.run.workspaceId,
    action: AuditActions.approvalRequested,
    actorType: 'agent',
    actorId: input.run.agentId,
    entityType: 'approval',
    entityId: row.id,
    recordId: input.run.recordId,
    workflowItemId: input.run.workflowItemId,
    workflowId: input.run.workflowId,
    runId: input.run.id,
    approvalId: row.id,
    summary: `Approval requested for ${input.descriptor.name}`,
    data: { toolKey: input.descriptor.key },
    occurredAt: now
  });

  publishRunEvent(db, {
    workspaceId: input.run.workspaceId,
    runId: input.run.id,
    recordId: input.run.recordId,
    workflowItemId: input.run.workflowItemId,
    type: RunEventTypes.approvalRequested,
    data: { approvalId: row.id, toolKey: input.descriptor.key }
  });

  return row;
}

// ---------------------------------------------------------------------------
// Step persistence and reconciliation
// ---------------------------------------------------------------------------

function loadSteps(db: Executor, runId: string): AgentRunStep[] {
  return db
    .select()
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(asc(agentRunSteps.index))
    .all();
}

function persistStep(
  db: Executor,
  input: {
    workspaceId: string;
    runId: string;
    index: number;
    type: AgentRunStep['type'];
    name?: string | null;
    status?: AgentRunStep['status'];
    input?: unknown;
    output?: unknown;
    error?: string | null;
    toolId?: string | null;
    toolKey?: string | null;
    metadata?: Record<string, unknown>;
  }
): string {
  const now = Date.now();
  const redactor = createRedactor(registeredSecretValues());
  const id = uuidv7(now);
  db.insert(agentRunSteps)
    .values({
      id,
      workspaceId: input.workspaceId,
      runId: input.runId,
      index: input.index,
      type: input.type,
      name: input.name ?? null,
      status: input.status ?? 'completed',
      input: (redactor.value(input.input) ?? null) as never,
      output: (redactor.value(input.output) ?? null) as never,
      error: input.error ?? null,
      toolId: input.toolId ?? null,
      toolKey: input.toolKey ?? null,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      metadata: (input.metadata ?? null) as never
    })
    .onConflictDoNothing()
    .run();
  return id;
}

async function rebuildMessages(
  db: Executor,
  run: AgentRun,
  state: WorkflowState,
  snapshot: AgentSnapshot,
  steps: AgentRunStep[]
): Promise<ChatMessage[]> {
  const contextStep = steps.find((step) => step.type === 'context');
  let base: ChatMessage[];
  if (contextStep) {
    const snapshotData = contextStep.output as { system?: string; user?: string } | null;
    base = [
      { role: 'system', content: snapshotData?.system ?? '' },
      { role: 'user', content: snapshotData?.user ?? '' }
    ];
  } else {
    const built =
      run.workflowItemId && run.recordId
        ? await buildRecordRunContext(db, {
            workspaceId: run.workspaceId,
            workflowItemId: run.workflowItemId,
            recordId: run.recordId,
            workflowId: run.workflowId,
            stateId: state.id,
            stateName: state.name,
            agent: snapshot,
            config: state.config?.context ?? null,
            requiredSubmission: state.config?.requiredSubmission ?? null
          })
        : missingSubject(run.workspaceId, run);
    base = built.messages;
  }

  const messages = [...base];
  for (const step of steps) {
    if (step.type === 'context') continue;
    if (step.type === 'message') {
      const output = step.output as { content?: string; toolCalls?: ToolCallRequest[] } | null;
      messages.push({
        role: 'assistant',
        content: output?.content ?? '',
        toolCalls: output?.toolCalls && output.toolCalls.length > 0 ? output.toolCalls : undefined
      });
    } else if (step.type === 'tool_result') {
      const metadata = (step.metadata as { toolCallId?: string } | null) ?? null;
      messages.push({
        role: 'tool',
        toolCallId: metadata?.toolCallId ?? step.id,
        name: step.toolKey ?? step.name ?? 'tool',
        content: JSON.stringify(step.output ?? { ok: step.status === 'completed' })
      });
    }
  }
  return messages;
}

/**
 * Complete tool calls that were persisted without a result — after a crash, a
 * lease expiry, or an approval that has since been decided.
 */
async function reconcilePendingToolCalls(
  db: Executor,
  options: {
    run: AgentRun;
    actor: ActorContext;
    snapshot: AgentSnapshot;
    toolDescriptors: ToolDescriptor[];
    messages: ChatMessage[];
    workspaceId: string;
    stepIndex: number;
    executionConfig: { continueOnToolError?: boolean; requireApprovalForMutations?: boolean };
    context: RunExecutionContext;
  }
): Promise<{
  status: 'ok' | 'awaiting_approval';
  messages: ChatMessage[];
  stepIndex: number;
  steps: number;
  approvalId?: string;
}> {
  const steps = loadSteps(db, options.run.id);
  const completedToolCalls = new Set<string>();
  for (const step of steps) {
    if (step.type === 'tool_result') {
      const metadata = (step.metadata as { toolCallId?: string } | null) ?? null;
      if (metadata?.toolCallId) completedToolCalls.add(metadata.toolCallId);
    }
  }

  const pending: Array<{ toolCall: ToolCallRequest; step: AgentRunStep }> = [];
  for (const step of steps) {
    if (step.type !== 'message') continue;
    const output = step.output as { toolCalls?: ToolCallRequest[] } | null;
    for (const toolCall of output?.toolCalls ?? []) {
      if (!completedToolCalls.has(toolCall.id)) pending.push({ toolCall, step });
    }
  }
  if (pending.length === 0) {
    return {
      status: 'ok',
      messages: options.messages,
      stepIndex: options.stepIndex,
      steps: 0
    };
  }

  let messages = options.messages;
  let stepIndex = options.stepIndex;
  let executed = 0;

  for (const { toolCall } of pending) {
    const descriptor = options.toolDescriptors.find((tool) => tool.key === toolCall.name);
    if (!descriptor) {
      stepIndex += 1;
      persistStep(db, {
        workspaceId: options.workspaceId,
        runId: options.run.id,
        index: stepIndex,
        type: 'tool_result',
        name: toolCall.name,
        status: 'failed',
        output: { ok: false, error: { code: 'unknown_tool', message: 'Tool no longer available' } },
        error: 'unknown_tool',
        metadata: { toolCallId: toolCall.id }
      });
      messages = [
        ...messages,
        {
          role: 'tool',
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify({ ok: false, error: { code: 'unknown_tool' } })
        }
      ];
      executed += 1;
      continue;
    }

    const policy = evaluateApprovalPolicy(descriptor, toolCall, options.executionConfig);
    const approval = existingApproval(db, options.run.id, toolCall.id);
    if (policy.required && (!approval || approval.status === 'pending')) {
      if (!approval) {
        const created = requestToolApproval(db, {
          run: options.run,
          actor: options.actor,
          toolCall,
          descriptor,
          reason: policy.reason
        });
        markRunStatus(db, options.run, 'awaiting_approval');
        return {
          status: 'awaiting_approval',
          messages,
          stepIndex,
          steps: executed,
          approvalId: created.id
        };
      }
      markRunStatus(db, options.run, 'awaiting_approval');
      return {
        status: 'awaiting_approval',
        messages,
        stepIndex,
        steps: executed,
        approvalId: approval.id
      };
    }

    if (approval && approval.status !== 'approved' && policy.required) {
      const rejection = {
        ok: false,
        error: {
          code: 'rejected',
          message: `A human rejected this action${approval.decisionComment ? `: ${approval.decisionComment}` : ''}`
        }
      };
      stepIndex += 1;
      persistStep(db, {
        workspaceId: options.workspaceId,
        runId: options.run.id,
        index: stepIndex,
        type: 'tool_result',
        name: toolCall.name,
        status: 'failed',
        output: rejection,
        error: 'rejected_by_reviewer',
        metadata: { toolCallId: toolCall.id, approvalId: approval.id }
      });
      messages = [
        ...messages,
        {
          role: 'tool',
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify(rejection)
        }
      ];
      executed += 1;
      continue;
    }

    const result = await runTool(db, {
      actor: options.actor,
      descriptor,
      toolCall,
      workspaceId: options.workspaceId,
      runId: options.run.id,
      recordId: options.run.recordId,
      workflowItemId: options.run.workflowItemId,
      workflowId: options.run.workflowId,
      stepId: `reconcile-${stepIndex + 1}`
    });
    stepIndex += 1;
    persistStep(db, {
      workspaceId: options.workspaceId,
      runId: options.run.id,
      index: stepIndex,
      type: 'tool_result',
      name: toolCall.name,
      status: result.ok ? 'completed' : 'failed',
      output: result.output,
      error: result.error?.message ?? null,
      toolId: descriptor.toolId,
      toolKey: toolCall.name,
      metadata: { toolCallId: toolCall.id, reconciled: true }
    });
    messages = [
      ...messages,
      {
        role: 'tool',
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: JSON.stringify(result.ok ? result.output : { ok: false, error: result.error })
      }
    ];
    executed += 1;
  }

  return { status: 'ok', messages, stepIndex, steps: executed };
}

// ---------------------------------------------------------------------------
// Run state transitions
// ---------------------------------------------------------------------------

export function markRunStatus(
  db: Executor,
  run: AgentRun,
  status: AgentRun['status'],
  extra: { startedAt?: number } = {}
): void {
  const now = Date.now();
  db.update(agentRuns)
    .set({
      status,
      startedAt: extra.startedAt ?? run.startedAt ?? now,
      updatedAt: now
    })
    .where(eq(agentRuns.id, run.id))
    .run();
  if (status === 'running') {
    publishRunEvent(db, {
      workspaceId: run.workspaceId,
      runId: run.id,
      recordId: run.recordId,
      workflowItemId: run.workflowItemId,
      type: RunEventTypes.runStarted,
      data: { runId: run.id }
    });
  }
}

function succeedRun(
  db: Executor,
  run: AgentRun,
  input: {
    output: unknown;
    outputText: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    stepId?: string | null;
  }
): void {
  const now = Date.now();
  db.update(agentRuns)
    .set({
      status: 'succeeded',
      output: (input.output ?? null) as never,
      outputText: input.outputText,
      usage: (input.usage as never) ?? null,
      finishedAt: now,
      durationMs: run.startedAt ? now - run.startedAt : null,
      error: null,
      errorCode: null,
      updatedAt: now
    })
    .where(eq(agentRuns.id, run.id))
    .run();

  writeAudit(db, {
    workspaceId: run.workspaceId,
    action: AuditActions.agentRunCompleted,
    actorType: 'agent',
    actorId: run.agentId,
    entityType: 'agent_run',
    entityId: run.id,
    recordId: run.recordId,
    workflowItemId: run.workflowItemId,
    workflowId: run.workflowId,
    runId: run.id,
    summary: 'Agent run completed',
    data: { usage: input.usage ?? null },
    occurredAt: now
  });

  publishRunEvent(
    db,
    {
      workspaceId: run.workspaceId,
      runId: run.id,
      recordId: run.recordId,
      workflowItemId: run.workflowItemId,
      type: RunEventTypes.runCompleted,
      data: { usage: input.usage ?? null, stepId: input.stepId ?? null }
    },
    now
  );
}

export function failRun(db: Executor, run: AgentRun, error: ReturnType<typeof toAppError>): void {
  const now = Date.now();
  db.update(agentRuns)
    .set({
      status: 'failed',
      error: error.message,
      errorCode: error.code,
      finishedAt: now,
      durationMs: run.startedAt ? now - run.startedAt : null,
      updatedAt: now
    })
    .where(eq(agentRuns.id, run.id))
    .run();

  writeAudit(db, {
    workspaceId: run.workspaceId,
    action: AuditActions.agentRunFailed,
    actorType: 'agent',
    actorId: run.agentId,
    entityType: 'agent_run',
    entityId: run.id,
    recordId: run.recordId,
    workflowItemId: run.workflowItemId,
    workflowId: run.workflowId,
    runId: run.id,
    summary: `Agent run failed: ${error.message}`,
    data: { code: error.code },
    occurredAt: now
  });

  publishRunEvent(
    db,
    {
      workspaceId: run.workspaceId,
      runId: run.id,
      recordId: run.recordId,
      workflowItemId: run.workflowItemId,
      type: RunEventTypes.runFailed,
      data: { error: error.message, code: error.code }
    },
    now
  );
}

export function cancelRun(db: Executor, run: AgentRun, reason: string): void {
  const now = Date.now();
  db.update(agentRuns)
    .set({ status: 'cancelled', error: reason, finishedAt: now, updatedAt: now })
    .where(eq(agentRuns.id, run.id))
    .run();
  writeAudit(db, {
    workspaceId: run.workspaceId,
    action: AuditActions.agentRunCancelled,
    actorType: 'system',
    entityType: 'agent_run',
    entityId: run.id,
    recordId: run.recordId,
    workflowItemId: run.workflowItemId,
    runId: run.id,
    summary: `Agent run cancelled: ${reason}`,
    occurredAt: now
  });
  publishRunEvent(
    db,
    {
      workspaceId: run.workspaceId,
      runId: run.id,
      recordId: run.recordId,
      workflowItemId: run.workflowItemId,
      type: RunEventTypes.runCancelled,
      data: { reason }
    },
    now
  );
}

/**
 * Parse the model's final answer against the agent's declared output schema.
 *
 * A model that ignores the schema must not silently produce a wrong shape: when
 * parsing fails and a schema was requested, the raw text is preserved and the
 * run is marked as having failed schema validation so the failure is visible.
 */
export function parseRunOutput(content: string, outputSchema: unknown): unknown {
  if (!outputSchema) return { text: content };
  const trimmed = content.trim();
  const jsonText = extractJson(trimmed);
  if (!jsonText) {
    return { text: content, schemaValid: false, schemaError: 'Response was not JSON' };
  }
  try {
    const parsed = JSON.parse(jsonText);
    return { data: parsed, schemaValid: true };
  } catch (error) {
    return {
      text: content,
      schemaValid: false,
      schemaError: error instanceof Error ? error.message : 'Invalid JSON'
    };
  }
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

/** Load a run with everything the Agent Work surface needs. */
export async function getRunDetail(db: Executor, workspaceId: string, runId: string) {
  const run = db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, workspaceId)))
    .limit(1)
    .all()[0];
  if (!run) throw errors.notFound('Agent run', runId);
  const steps = loadSteps(db, runId);
  const agent = db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1).all()[0];
  const versionRow = run.agentVersionId
    ? db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.id, run.agentVersionId))
        .limit(1)
        .all()[0]
    : undefined;
  const approvals = db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.runId, runId))
    .all();
  return {
    run,
    steps,
    agent: agent ? { id: agent.id, name: agent.name } : null,
    agentSnapshot: versionRow?.snapshot ?? null,
    approvals
  };
}

/** Runs for a work item, newest first — the Agent Work tab. */
export async function listWorkflowItemRuns(
  db: Executor,
  workspaceId: string,
  workflowItemId: string,
  options: { limit?: number } = {}
) {
  return db
    .select()
    .from(agentRuns)
    .where(
      and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.workflowItemId, workflowItemId))
    )
    .orderBy(asc(agentRuns.createdAt))
    .limit(Math.min(options.limit ?? 50, 200))
    .all();
}

/** Runs stuck in `running` after a crash, for the recovery maintenance job. */
export async function findStaleRuns(db: Executor, olderThanMs: number, now = Date.now()) {
  return db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.status, 'running'), lt(agentRuns.updatedAt, now - olderThanMs)))
    .all();
}
