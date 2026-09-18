/**
 * Schema-authoring API client.
 *
 * The test endpoint is stateless, so the Object Type, workflow overlay and state
 * editors all run the same evaluator the engine runs at validation time.
 */
import { api } from '$ui/api';
import type { ObjectTypeFieldView } from '$ui/records/types';
import type { WorkflowFieldView } from '$ui/work/types';
import type { ZodProjectedField, ZodSchemaTestResult } from './types';

export interface ObjectTypeSchemaSaveResult {
  source: string;
  fields: ObjectTypeFieldView[];
  projected: ZodProjectedField[];
}

export interface WorkflowSchemaSaveResult {
  source: string;
  fields: WorkflowFieldView[];
  projected: ZodProjectedField[];
}

export const schemaApi = {
  test: (source: string, sample: unknown): Promise<ZodSchemaTestResult> =>
    api.post<ZodSchemaTestResult>('/schemas/test', { source, sample }),
  saveObjectType: (objectTypeId: string, source: string): Promise<ObjectTypeSchemaSaveResult> =>
    api.put<ObjectTypeSchemaSaveResult>(`/object-types/${objectTypeId}/zod-schema`, { source }),
  saveWorkflow: (workflowId: string, source: string): Promise<WorkflowSchemaSaveResult> =>
    api.put<WorkflowSchemaSaveResult>(`/workflows/${workflowId}/zod-schema`, { source })
};
