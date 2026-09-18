/**
 * Typed wrappers for the universal Records / Object Types / WorkflowItems API.
 * The generic `api` client already handles transport; this module owns the paths
 * and response shapes so components stay declarative.
 */
import { api } from '$ui/api';
import type {
  EffectiveField,
  ObjectTypeFieldView,
  ObjectTypeSummary,
  RecordDetail,
  RecordFieldHistoryEntry,
  RecordFileView,
  RecordListPage,
  RecordListRow,
  RecordNoteView,
  RecordSummary,
  RelatedRecordView,
  WorkflowItemListRow
} from './types';

export const recordsApi = {
  // Object Types
  listObjectTypes: async (): Promise<ObjectTypeSummary[]> =>
    (await api.get<{ objectTypes: ObjectTypeSummary[] }>('/object-types')).objectTypes,
  createObjectType: async (input: {
    key?: string;
    name: string;
    pluralName?: string;
    description?: string;
    settings?: Record<string, unknown>;
  }): Promise<ObjectTypeSummary> =>
    (await api.post<{ objectType: ObjectTypeSummary }>('/object-types', input)).objectType,
  updateObjectType: async (
    id: string,
    input: Partial<{ name: string; pluralName: string; description: string }>
  ): Promise<ObjectTypeSummary> =>
    (await api.patch<{ objectType: ObjectTypeSummary }>(`/object-types/${id}`, input)).objectType,
  archiveObjectType: (id: string) => api.post(`/object-types/${id}/archive`, {}),
  objectTypeFields: async (id: string): Promise<ObjectTypeFieldView[]> =>
    (await api.get<{ fields: ObjectTypeFieldView[] }>(`/object-types/${id}/fields`)).fields,
  setObjectTypeFields: async (
    id: string,
    fields: Array<Record<string, unknown>>
  ): Promise<ObjectTypeFieldView[]> =>
    (await api.put<{ fields: ObjectTypeFieldView[] }>(`/object-types/${id}/fields`, { fields }))
      .fields,

  // Records
  listRecords: (query: {
    objectTypeId?: string;
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<RecordListPage> => api.get<RecordListPage>('/records', query),
  getRecord: (id: string): Promise<RecordDetail> => api.get<RecordDetail>(`/records/${id}`),
  createRecord: async (input: {
    objectTypeId: string;
    displayName?: string | null;
    fields?: Record<string, unknown>;
  }): Promise<RecordSummary> =>
    (
      await api.post<{ record: RecordSummary }>('/records', {
        objectTypeId: input.objectTypeId,
        displayName: input.displayName,
        fields: input.fields ?? {}
      })
    ).record,
  updateRecord: async (
    id: string,
    input: {
      displayName?: string | null;
      fields?: Record<string, unknown>;
      expectedVersion?: number;
    }
  ): Promise<{ record: { id: string; version: number }; changes: Array<{ key: string }> }> =>
    api.patch(`/records/${id}`, input),
  archiveRecord: (id: string) => api.post(`/records/${id}/archive`, {}),
  recordHistory: async (id: string): Promise<RecordFieldHistoryEntry[]> =>
    (await api.get<{ history: RecordFieldHistoryEntry[] }>(`/records/${id}/history`)).history,
  recordFiles: async (id: string): Promise<RecordFileView[]> =>
    (await api.get<{ files: RecordFileView[] }>(`/records/${id}/files`)).files,
  recordNotes: async (id: string): Promise<RecordNoteView[]> =>
    (await api.get<{ notes: RecordNoteView[] }>(`/records/${id}/notes`)).notes,
  addRecordNote: (id: string, body: string) =>
    api.post<{ noteId: string }>(`/records/${id}/notes`, { body }),
  recordRelated: async (id: string): Promise<RelatedRecordView[]> =>
    (await api.get<{ related: RelatedRecordView[] }>(`/records/${id}/related`)).related,
  linkRelated: (
    id: string,
    input: { toRecordId: string; relationshipKey: string; note?: string }
  ) => api.post(`/records/${id}/related`, input),
  unlinkRelated: (id: string, relationshipId: string) =>
    api.delete(`/records/${id}/related/${relationshipId}`),

  // Workflow items
  listWorkItems: async (query: {
    recordId?: string;
    limit?: number;
  }): Promise<WorkflowItemListRow[]> =>
    (await api.get<{ items: WorkflowItemListRow[] }>('/workflow-items', query)).items,
  dispatchWorkItem: (id: string, body: { stateId?: string; reason?: string } = {}) =>
    api.post(`/workflow-items/${id}/dispatch`, body)
};

export type { EffectiveField, RecordListRow };
