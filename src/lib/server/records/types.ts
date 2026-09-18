/**
 * Universal Record vocabulary (ADR-0021).
 *
 * A Record is a durable thing Mentat knows about. Its Object Type is the schema;
 * a WorkflowItem (see `workflow-items/`) is a Record's participation in a Workflow.
 * Object Types are user-defined; there is no privileged built-in type.
 */
import type { FieldDefinition, FieldType } from '../db/schema';

/** Work relationship types are kept separate from domain relationship types. */
export type DomainRelationshipType = string;

/** A field that is part of an Object Type's effective schema. */
export interface ObjectTypeFieldView {
  /** The `object_type_fields` binding id. */
  bindingId: string;
  fieldDefinitionId: string;
  key: string;
  name: string;
  description: string | null;
  type: FieldType;
  options: FieldDefinition['options'];
  validation: FieldDefinition['validation'];
  display: FieldDefinition['display'];
  required: boolean;
  isIdentity: boolean;
  isPrimaryDisplay: boolean;
  isSecondaryDisplay: boolean;
  showInList: boolean;
  showOnCard: boolean;
  filterable: boolean;
  position: number;
  defaultValue: unknown;
}

/** Effective field = the definition plus binding flags, marked with provenance. */
export interface EffectiveField extends ObjectTypeFieldView {
  source: 'base' | 'workflow';
}

export interface ObjectTypeSummary {
  id: string;
  key: string;
  name: string;
  pluralName: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  isSystem: boolean;
  position: number;
  settings: Record<string, unknown>;
  fieldCount: number;
  recordCount: number;
}

export const PRIORITY_CHOICES = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' }
];

export function defaultPluralName(name: string): string {
  if (name.endsWith('s')) return name;
  if (name.endsWith('y')) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

export function defaultKeyPrefix(key: string): string {
  return (
    key
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase()
      .slice(0, 12) || 'REC'
  );
}
