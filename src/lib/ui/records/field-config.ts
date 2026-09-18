/**
 * Adapts an Object Type field view to the shared typed-field editor contract so
 * the existing `FieldInput`/`FieldValue` components can render Record fields
 * without a second field renderer.
 */
import type { WorkItemFieldConfig } from '$ui/work/types';
import type { EffectiveField } from './types';

export function toFieldConfig(field: EffectiveField, editable = true): WorkItemFieldConfig {
  return {
    key: field.key,
    name: field.name,
    type: field.type,
    required: field.required,
    editable,
    visible: true,
    showOnCard: field.showOnCard,
    showInList: field.showInList,
    requiredInStates: null,
    options: field.options
  };
}
