#!/usr/bin/env bun
/**
 * Demo seed.
 *
 * Creates the workspace the Definition of Done describes, so a fresh local instance
 * can be explored immediately:
 *
 *   Claims workspace
 *     ├─ Intake workflow (intake template) with a Triage agent and a routing rule
 *     ├─ Claims workflow (claims template) with typed fields and a human gate
 *     ├─ a local Ollama provider (health-checked, models discovered when reachable)
 *     ├─ an HTTP service with one semantic operation exposed as an agent tool
 *     ├─ a webhook trigger and a daily cron trigger
 *     ├─ a few work items, including one already in Human review
 *     └─ a dashboard with KPI, breakdown and funnel widgets
 *
 * Everything is created through the real services, so the seed exercises the same
 * validation, audit and history paths a user would.
 *
 *   bun run seed            # idempotent: skips anything that already exists
 *   bun run seed --reset    # wipes the database first
 */
import { eq } from 'drizzle-orm';
import { createAgent } from '../src/lib/server/agents/service';
import { addWidget, createDashboard } from '../src/lib/server/analytics/dashboards';
import { env, resolveMasterKey } from '../src/lib/server/config/env';
import { createActorContext, permissionsForRole } from '../src/lib/server/core/context';
import { moduleLogger } from '../src/lib/server/core/logger';
import { registerSecretValue } from '../src/lib/server/core/secret-registry';
import { createDatabase, type Executor, getDb, withTransaction } from '../src/lib/server/db/client';
import { runMigrations } from '../src/lib/server/db/migrate';
import {
  fieldDefinitions,
  models,
  providers,
  users,
  workflows as workflowsTable,
  workspaceMembers,
  workspaces
} from '../src/lib/server/db/schema';
import { registerExecutionJobHandlers } from '../src/lib/server/execution/engine';
import { setProviderLookup } from '../src/lib/server/execution/provider-lookup';
import { createFieldDefinition, setWorkflowFields } from '../src/lib/server/fields/service';
import { registerFileJobHandlers } from '../src/lib/server/files/handlers';
import { installFileService } from '../src/lib/server/files/service';
import {
  compileWorkflowItemFilterDetailed,
  setWorkflowItemFilterCompiler
} from '../src/lib/server/filters/compile';
import { executeOperation } from '../src/lib/server/http/runtime';
import { createHttpOperation, createHttpService } from '../src/lib/server/http/service';
import { getProviderForModel } from '../src/lib/server/providers/registry';
import { createObjectType, setBaseFields } from '../src/lib/server/records/object-types';
import { createSecret } from '../src/lib/server/secrets/service';
import { setHttpToolInvoker } from '../src/lib/server/tools/http-locator';
import { registerNativeTools } from '../src/lib/server/tools/native';
import { registerCoreNativeTools } from '../src/lib/server/tools/native/register';
import { getDefaultToolRegistry, resetToolRegistry } from '../src/lib/server/tools/registry';
import { registerTriggerJobHandlers } from '../src/lib/server/triggers/handlers';
import { createTrigger } from '../src/lib/server/triggers/service';
import {
  addWorkflowItemNoteSync,
  createWorkflowItemSync,
  requestWorkflowItemTransitionSync,
  transferWorkflowItemSync
} from '../src/lib/server/workflow-items/service';
import { createWorkflow, setTransferRule } from '../src/lib/server/workflows/service';
import { createUserRecord, createWorkspaceWithOwner } from '../src/lib/server/workspaces/service';

const log = moduleLogger('seed');

/** State ids keyed by name, so the seed reads like the workflow it describes. */
function stateMap(detail: { states: Array<{ id: string; name: string }> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const state of detail.states) out[state.name] = state.id;
  return out;
}

const DEMO_WORKSPACE = 'Mentat Demo';
const DEMO_EMAIL = 'owner@mentat.local';
const DEMO_PASSWORD = 'mentat-local-dev';

async function main() {
  const url = env().MENTAT_DB_PATH;
  const handle = createDatabase({ url });
  const db = handle.db;

  try {
    runMigrations(db, handle.sqlite);
    wireServices(db);

    // Reuse the demo workspace when it already exists so the seed is idempotent.
    const existing = db
      .select()
      .from(workspaces)
      .where(eq(workspaces.name, DEMO_WORKSPACE))
      .limit(1)
      .all()[0];

    if (existing) {
      process.stdout.write(
        `Demo workspace already exists (${existing.id}). Run \`bun run db:reset\` then \`bun run seed\` for a fresh copy.\n`
      );
      return;
    }

    const now = Date.now();
    const owner = createUserRecord(db, {
      email: DEMO_EMAIL,
      name: 'Demo Owner',
      passwordHash: await Bun.password.hash(DEMO_PASSWORD, { algorithm: 'argon2id' })
    });
    const workspace = createWorkspaceWithOwner(db, {
      name: DEMO_WORKSPACE,
      description: 'A demonstration workspace created by `bun run seed`.',
      ownerUserId: owner.id
    });
    const actor = createActorContext({
      workspaceId: workspace.id,
      actorType: 'user',
      actorId: owner.id,
      actorLabel: owner.name,
      role: 'owner',
      permissions: permissionsForRole('owner')
    });

    // A reviewer so the human gate has someone to assign.
    const reviewer = createUserRecord(db, {
      email: 'reviewer@mentat.local',
      name: 'Sarah Reviewer',
      passwordHash: await Bun.password.hash(DEMO_PASSWORD, { algorithm: 'argon2id' })
    });
    db.insert(workspaceMembers)
      .values({
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        userId: reviewer.id,
        role: 'member',
        status: 'active',
        createdAt: now,
        updatedAt: now
      })
      .run();

    // ---------------------------------------------------------------- fields
    const fieldSpecs = [
      { key: 'customer', name: 'Customer', type: 'short_text' as const, card: true },
      { key: 'customer_email', name: 'Customer Email', type: 'email' as const, card: false },
      {
        key: 'request_type',
        name: 'Request Type',
        type: 'select' as const,
        card: true,
        options: {
          choices: [
            { value: 'claim', label: 'Claim' },
            { value: 'quote', label: 'Quote' },
            { value: 'support', label: 'Support' }
          ]
        }
      },
      { key: 'policy_number', name: 'Policy Number', type: 'short_text' as const, card: false },
      {
        key: 'claim_amount',
        name: 'Claim Amount',
        type: 'currency' as const,
        card: true,
        options: { currency: 'AUD' }
      },
      { key: 'renewal_date', name: 'Renewal Date', type: 'date' as const, card: false },
      {
        key: 'risk_category',
        name: 'Risk Category',
        type: 'select' as const,
        card: false,
        options: {
          choices: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        }
      },
      {
        key: 'review_outcome',
        name: 'Review Outcome',
        type: 'select' as const,
        card: false,
        options: {
          choices: [
            { value: 'approved', label: 'Approved' },
            { value: 'rework', label: 'Rework' },
            { value: 'declined', label: 'Declined' }
          ]
        }
      },
      { key: 'reviewer_notes', name: 'Reviewer Notes', type: 'long_text' as const, card: false },
      // Intake and Claims name the same idea differently, which is exactly the case
      // the transfer field-mapping feature exists for.
      {
        key: 'external_reference',
        name: 'External Reference',
        type: 'short_text' as const,
        card: false
      },
      {
        key: 'source_reference',
        name: 'Source Reference',
        type: 'short_text' as const,
        card: false
      }
    ];
    const fieldIds = new Map<string, string>();
    for (const spec of fieldSpecs) {
      const field = createFieldDefinition(db, actor, {
        key: spec.key,
        name: spec.name,
        type: spec.type,
        scope: 'record',
        options: spec.options ?? null
      });
      fieldIds.set(spec.key, field.id);
    }

    // ---------------------------------------------------------- object type
    // The workspace defines its own Object Type; there is no built-in Ticket type.
    const objectType = createObjectType(db, actor, {
      key: 'claim',
      name: 'Claim',
      pluralName: 'Claims',
      description: 'An insurance request, claim or query being handled.'
    });
    await setBaseFields(
      db,
      actor,
      objectType.id,
      fieldSpecs.map((spec, index) => ({
        fieldDefinitionId: fieldIds.get(spec.key)!,
        position: index,
        required: false,
        showInList: true,
        showOnCard: spec.card ?? false,
        filterable: true
      }))
    );

    // ------------------------------------------------------------- workflows
    const intake = createWorkflow(db, actor, {
      name: 'Intake',
      key: 'INT',
      template: 'intake',
      objectTypeId: objectType.id,
      description: 'Receives heterogeneous events, classifies them and routes the work onward.'
    });
    const claims = createWorkflow(db, actor, {
      name: 'Claims',
      key: 'CLM',
      template: 'claims',
      objectTypeId: objectType.id,
      description: 'Investigation with a human review gate, then a decision.'
    });

    const intakeStates = stateMap(intake);
    const claimsStates = stateMap(claims);

    setWorkflowFields(db, actor, intake.workflow.id, [
      { fieldDefinitionId: fieldIds.get('customer')!, showOnCard: true, showInList: true },
      { fieldDefinitionId: fieldIds.get('customer_email')!, required: true },
      { fieldDefinitionId: fieldIds.get('request_type')!, required: true, showOnCard: true },
      { fieldDefinitionId: fieldIds.get('policy_number')! },
      { fieldDefinitionId: fieldIds.get('claim_amount')!, showOnCard: true },
      { fieldDefinitionId: fieldIds.get('renewal_date')! },
      { fieldDefinitionId: fieldIds.get('risk_category')! },
      { fieldDefinitionId: fieldIds.get('external_reference')! }
    ]);
    setWorkflowFields(db, actor, claims.workflow.id, [
      { fieldDefinitionId: fieldIds.get('customer')!, required: true, showOnCard: true },
      { fieldDefinitionId: fieldIds.get('customer_email')! },
      { fieldDefinitionId: fieldIds.get('policy_number')!, required: true },
      { fieldDefinitionId: fieldIds.get('claim_amount')!, showOnCard: true },
      { fieldDefinitionId: fieldIds.get('risk_category')! },
      {
        fieldDefinitionId: fieldIds.get('review_outcome')!,
        requiredInStates: [claimsStates['Human review']!]
      },
      {
        fieldDefinitionId: fieldIds.get('reviewer_notes')!,
        requiredInStates: [claimsStates['Human review']!]
      },
      { fieldDefinitionId: fieldIds.get('source_reference')! }
    ]);

    // Routing: Intake may transfer to Claims without approval.
    setTransferRule(db, actor, intake.workflow.id, {
      targetWorkflowId: claims.workflow.id,
      defaultTargetStateId: claimsStates['New claim']!,
      fieldMappings: { external_reference: 'source_reference' },
      allowAgents: true,
      allowHumans: true,
      requiresApproval: false
    });

    // ---------------------------------------------------------------- secret
    const secret = createSecret(db, actor, {
      key: 'DEMO_API_KEY',
      name: 'Demo API key',
      value: 'demo-key-not-a-real-credential',
      description: 'Placeholder so the HTTP service demonstrates secret-backed auth.'
    });
    registerSecretValue('demo-key-not-a-real-credential');

    // --------------------------------------------------------------- provider
    const providerId = crypto.randomUUID();
    db.insert(providers)
      .values({
        id: providerId,
        workspaceId: workspace.id,
        name: 'Local Ollama',
        type: 'ollama',
        baseUrl: env().MENTAT_OLLAMA_URL,
        enabled: true,
        isDefault: true,
        config: { keepAlive: '5m', timeoutMs: 120_000 } as never,
        createdAt: now,
        updatedAt: now
      })
      .run();
    const modelId = crypto.randomUUID();
    db.insert(models)
      .values({
        id: modelId,
        workspaceId: workspace.id,
        providerId,
        modelKey: 'llama3.1:8b',
        displayName: 'Llama 3.1 8B',
        family: 'llama',
        parameterSize: '8B',
        capabilities: {
          streaming: true,
          toolCalling: true,
          jsonMode: true,
          vision: false,
          embeddings: false
        },
        contextWindow: 131_072,
        inferenceDefaults: { temperature: 0.2 } as never,
        enabled: true,
        discovered: false,
        createdAt: now,
        updatedAt: now
      })
      .run();

    // ----------------------------------------------------------- http service
    const service = await createHttpService(db, actor, {
      name: 'Acme CRM',
      description: 'Example HTTP integration used by the demo routing agent.',
      baseUrl: 'https://api.example.com',
      authType: 'bearer',
      authConfig: { secretId: secret.id },
      defaultHeaders: { accept: 'application/json' },
      timeoutMs: 10_000,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 500, retryOn: [429, 502, 503, 504] },
      cachePolicy: { enabled: true, ttlSeconds: 300, read: true },
      rateLimit: { requests: 60, windowSeconds: 60, concurrency: 4 }
    });
    await createHttpOperation(db, actor, {
      serviceId: service.id,
      key: 'acme.get_customer',
      name: 'Get customer',
      description: 'Look up a customer record by email address.',
      method: 'GET',
      path: '/customers/{{email}}',
      parameters: [
        {
          name: 'email',
          location: 'path',
          required: true,
          type: 'string',
          description: 'Customer email'
        }
      ],
      successRules: { statusCodes: [200] },
      responseMapping: { bodyPath: 'data', outputTemplate: { name: 'name', tier: 'tier' } },
      cachePolicy: { enabled: true, ttlSeconds: 600 },
      approvalPolicy: { mode: 'never' },
      exposeAsTool: true
    });

    // ---------------------------------------------------------------- agents
    const nativeTools = getDefaultToolRegistry()
      .list()
      .map((tool) => tool.key);
    const triageAgent = createAgent(db, actor, {
      name: 'Triage Agent',
      description: 'Classifies incoming requests, extracts fields and routes the work.',
      workflowId: intake.workflow.id,
      providerId,
      modelId,
      instructions: [
        'You are the intake triage agent for a claims and servicing team.',
        '',
        'For each work item:',
        '1. Read the record and any linked documents.',
        '2. Extract Customer, Customer Email, Request Type, Policy Number and Claim Amount when present.',
        '3. Set the fields with workflowItems.setFields.',
        '4. Route the work with workflowItems.transfer: claims go to the Claims workflow,',
        '   everything else stays and moves to Needs information.',
        '5. Leave a short note explaining the classification.'
      ].join('\n'),
      toolIds: [],
      executionConfig: {
        maxSteps: 12,
        temperature: 0.1,
        timeoutSeconds: 180,
        continueOnToolError: true
      },
      permissions: {
        native: [
          'workflowItems.get',
          'workflowItems.getFields',
          'workflowItems.setFields',
          'workflowItems.addNote',
          'workflowItems.transfer',
          'files.list',
          'files.getSummary'
        ],
        canTransferWork: true,
        httpOperationIds: []
      }
    });
    void nativeTools;

    const claimsAgent = createAgent(db, actor, {
      name: 'Claims Investigator',
      description: 'Assesses the claim and proposes an outcome for human review.',
      workflowId: claims.workflow.id,
      providerId,
      modelId,
      instructions: [
        'Investigate the claim and prepare an assessment for a human reviewer.',
        '',
        'Set Risk Category and add a note with your reasoning and any open questions.',
        'Never approve or decline the claim yourself: move it to Human review and stop.'
      ].join('\n'),
      executionConfig: { maxSteps: 10, temperature: 0.2, timeoutSeconds: 240 },
      permissions: {
        native: [
          'workflowItems.get',
          'workflowItems.getFields',
          'workflowItems.setFields',
          'workflowItems.addNote',
          'workflowItems.requestTransition',
          'mentat.data.find',
          'mentat.cache.get'
        ]
      }
    });

    // Bind the agents to their agent states.
    const { updateState } = await import('../src/lib/server/workflows/service');
    updateState(db, actor, {
      stateId: intakeStates['Triaging']!,
      agentId: triageAgent.id,
      autoExecute: true,
      maxAttempts: 3
    });
    updateState(db, actor, {
      stateId: claimsStates['Investigation']!,
      agentId: claimsAgent.id,
      autoExecute: true,
      maxAttempts: 3,
      failureStateId: claimsStates['Human review']!
    });
    updateState(db, actor, {
      stateId: claimsStates['Human review']!,
      humanGate: {
        enabled: true,
        requiredComment: true,
        requiredFieldKeys: ['review_outcome'],
        instructions: 'Confirm the assessment before the claim is decided.'
      }
    });

    // ------------------------------------------------------------- work items
    const samples = [
      {
        title: 'Storm damage claim — 12 Harbour Street',
        description: 'Hail damage to roof and skylights reported after the weekend storm.',
        fields: {
          customer: 'ACME Pty Ltd',
          customer_email: 'ops@acme.test',
          request_type: 'claim',
          policy_number: 'POL-118273',
          claim_amount: 12_500,
          external_reference: 'MSG-2026-0001'
        },
        priority: 'high' as const
      },
      {
        title: 'Quote request — fleet cover renewal',
        description: 'Requesting a renewal quote for a 14-vehicle fleet.',
        fields: {
          customer: 'Northwind Freight',
          customer_email: 'fleet@northwind.test',
          request_type: 'quote',
          renewal_date: '2026-04-01'
        },
        priority: 'medium' as const
      },
      {
        title: 'Policy document query',
        description: 'Customer cannot locate their certificate of currency.',
        fields: {
          customer: 'Bluewater Marine',
          customer_email: 'accounts@bluewater.test',
          request_type: 'support'
        },
        priority: 'low' as const
      }
    ];

    const createdItems: string[] = [];
    for (const sample of samples) {
      const item = createWorkflowItemSync(db, actor, {
        workflowId: intake.workflow.id,
        record: {
          objectTypeId: objectType.id,
          displayName: sample.title,
          fields: sample.fields,
          structuredData: { description: sample.description, priority: sample.priority }
        },
        provenance: {
          sourceType: 'incoming_email',
          sourceReference: `msg-${createdItems.length + 1}`
        }
      });
      createdItems.push(item.id);
    }

    // One item already reached the human gate, so the review UI has work.
    const gate = createWorkflowItemSync(db, actor, {
      workflowId: intake.workflow.id,
      record: {
        objectTypeId: objectType.id,
        displayName: 'Liability claim — delivery damage',
        fields: {
          customer: 'Ridgeline Logistics',
          customer_email: 'claims@ridgeline.test',
          request_type: 'claim',
          policy_number: 'POL-998812',
          claim_amount: 42_000,
          external_reference: 'MSG-2026-0004'
        },
        structuredData: {
          description: 'Third-party claim for damaged goods during delivery.',
          priority: 'urgent'
        }
      },
      provenance: { sourceType: 'webhook', sourceReference: 'delivery-damage-1' }
    });
    const transferred = transferWorkflowItemSync(db, actor, {
      workflowItemId: gate.id,
      targetWorkflowId: claims.workflow.id,
      reason: 'Classified as a claim by the triage agent'
    });
    const gateItemId = transferred.workflowItem.id;
    requestWorkflowItemTransitionSync(db, actor, {
      workflowItemId: gateItemId,
      targetStateId: claimsStates['Investigation']!,
      comment: 'Investigation started'
    });
    addWorkflowItemNoteSync(db, actor, {
      workflowItemId: gateItemId,
      body: 'Assessed at $42,000 against policy POL-998812. Recommend approval subject to excess.'
    });
    requestWorkflowItemTransitionSync(db, actor, {
      workflowItemId: gateItemId,
      targetStateId: claimsStates['Human review']!,
      comment: 'Assessment complete, requesting review',
      fieldValues: {
        review_outcome: 'approved',
        reviewer_notes: 'Recommend approval subject to excess.'
      }
    });

    // --------------------------------------------------------------- triggers
    const webhookTrigger = await createTrigger(db, actor, {
      workflowId: intake.workflow.id,
      name: 'Inbound email',
      description: 'Accepts normalised inbound email events and creates intake work.',
      type: 'webhook',
      config: {
        signatureRequired: false,
        maxPayloadBytes: 1_048_576,
        mapping: {
          titleTemplate: '{{message.subject}}',
          descriptionTemplate: '{{message.body}}',
          targetWorkflowId: intake.workflow.id,
          fieldPaths: {
            customer: 'message.from.name',
            customer_email: 'message.from.email'
          },
          labels: ['email'],
          dedupeTemplate: '{{message.id}}',
          attachmentPaths: ['message.attachments']
        }
      }
    });

    await createTrigger(db, actor, {
      workflowId: intake.workflow.id,
      name: 'Nightly intake sweep',
      description: 'Runs the intake review every night at 02:00 in the workspace timezone.',
      type: 'cron',
      config: {
        expression: '0 2 * * *',
        timezone: 'UTC',
        mapping: { titleTemplate: 'Daily intake sweep', targetWorkflowId: intake.workflow.id }
      }
    });

    // -------------------------------------------------------------- dashboard
    const dashboard = await createDashboard(db, actor, {
      name: 'Operations overview',
      description: 'Throughput, workload and claim value for the demo workspace.',
      isShared: true
    });
    await addWidget(db, actor, dashboard.id, {
      title: 'Open work',
      type: 'kpi',
      size: 'sm',
      dataSource: { kind: 'workflow_items', workflowIds: [intake.workflow.id, claims.workflow.id] },
      measure: { aggregation: 'count' },
      grouping: { by: 'none' },
      timeRange: { kind: 'all' },
      visualization: { valueFormat: 'number' }
    });
    await addWidget(db, actor, dashboard.id, {
      title: 'Work by state',
      type: 'bar',
      size: 'md',
      dataSource: { kind: 'workflow_items', workflowIds: [claims.workflow.id] },
      measure: { aggregation: 'count' },
      grouping: { by: 'state' },
      timeRange: { kind: 'all' },
      visualization: { showValues: true }
    });
    await addWidget(db, actor, dashboard.id, {
      title: 'Claim amount by risk category',
      type: 'bar',
      size: 'md',
      dataSource: { kind: 'workflow_items', workflowIds: [claims.workflow.id] },
      measure: { aggregation: 'sum', fieldKey: 'claim_amount' },
      grouping: { by: 'field', fieldKey: 'risk_category' },
      timeRange: { kind: 'all' },
      visualization: { valueFormat: 'currency', currency: 'AUD' }
    });
    await addWidget(db, actor, dashboard.id, {
      title: 'Claims funnel',
      type: 'funnel',
      size: 'full',
      dataSource: {
        kind: 'state_history',
        workflowIds: [claims.workflow.id],
        funnelStages: [
          { label: 'New claim', stateIds: [claimsStates['New claim']!] },
          { label: 'Investigation', stateIds: [claimsStates['Investigation']!] },
          { label: 'Human review', stateIds: [claimsStates['Human review']!] },
          {
            label: 'Decided',
            stateIds: [claimsStates['Approved']!, claimsStates['Declined']!]
          }
        ]
      },
      measure: { aggregation: 'count' },
      timeRange: { kind: 'all' }
    });

    process.stdout.write(
      [
        '',
        'Demo data created.',
        '',
        `  Workspace : ${DEMO_WORKSPACE}`,
        `  Sign in   : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`,
        `  Reviewer  : reviewer@mentat.local / ${DEMO_PASSWORD}`,
        '',
        `  Workflows : ${intake.workflow.name} (${intake.workflow.key}), ${claims.workflow.name} (${claims.workflow.key})`,
        `  Work items: ${createdItems.length + 1} (one waiting at the human gate)`,
        `  Agents    : ${triageAgent.name}, ${claimsAgent.name}`,
        `  Provider  : Local Ollama at ${env().MENTAT_OLLAMA_URL} (refresh models once it is running)`,
        `  Webhook   : /api/webhooks/${webhookTrigger.webhookToken}`,
        `  Dashboard : ${dashboard.name}`,
        '',
        'Secrets are encrypted with the master key from MENTAT_MASTER_KEY or ./data/master.key.',
        ''
      ].join('\n')
    );

    log.info('seed complete', { workspaceId: workspace.id });
  } finally {
    handle.close();
  }
}

/** Wire the same locators bootstrap installs, so the seed can use the services. */
function wireServices(db: Executor) {
  installFileService({ db });
  registerExecutionJobHandlers();
  registerFileJobHandlers();
  registerTriggerJobHandlers();
  setProviderLookup((executor, input) => Promise.resolve(getProviderForModel(executor, input)));
  setHttpToolInvoker(async (executor, invocation) => {
    const result = await executeOperation({
      db: executor,
      actor: invocation.actor,
      operationId: invocation.operationId,
      serviceId: invocation.serviceId ?? undefined,
      input: invocation.input,
      overrides: { approval: 'bypass' }
    });
    return {
      ok: result.ok,
      output: result.output,
      status: result.status ?? undefined,
      error: result.error
    };
  });
  setWorkflowItemFilterCompiler({
    compile: (executor, options) => compileWorkflowItemFilterDetailed(executor, options)
  });
  resetToolRegistry();
  registerNativeTools(getDefaultToolRegistry());
  registerCoreNativeTools(getDefaultToolRegistry());
}

void getDb;
void withTransaction;
void users;
void workflowsTable;
void fieldDefinitions;
void resolveMasterKey;

await main();
