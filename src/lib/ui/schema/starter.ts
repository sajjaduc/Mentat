/**
 * Starter-schema generation for legacy typed fields.
 *
 * Object Types and workflows that predate Zod-source authoring already have typed
 * fields. This turns them into an equivalent starting Zod expression so the schema
 * box opens with something real instead of an empty page, carrying identity and
 * display flags across as `.meta({...})`. It is a starting point, not a round-trip:
 * saving the generated schema is what makes it authoritative.
 */
import type { FieldOptions, FieldType } from '$ui/work/types';

export interface StarterField {
  key: string;
  name: string;
  type: FieldType;
  required: boolean;
  options?: FieldOptions | null;
  isIdentity?: boolean;
  isPrimaryDisplay?: boolean;
  showInList?: boolean;
  showOnCard?: boolean;
  filterable?: boolean;
}

export function buildStarterZodSchema(fields: StarterField[]): string {
  if (fields.length === 0) return 'z.object({\n  \n})';
  const lines = fields.map((field) => {
    const optional = field.required ? '' : '.optional()';
    return `  ${field.key}: ${baseExpression(field)}${optional}${metaExpression(field)}`;
  });
  return `z.object({\n${lines.join(',\n')}\n})`;
}

function baseExpression(field: StarterField): string {
  switch (field.type) {
    case 'email':
      return 'z.email()';
    case 'url':
      return 'z.url()';
    case 'number':
    case 'currency':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'select': {
      const choices = choiceValues(field.options);
      return choices.length > 0 ? `z.enum([${choices}])` : 'z.string()';
    }
    case 'multi_select': {
      const choices = choiceValues(field.options);
      return choices.length > 0 ? `z.array(z.enum([${choices}]))` : 'z.array(z.string())';
    }
    case 'json':
      return 'z.unknown()';
    default:
      return 'z.string()';
  }
}

/** Only emit meta that differs from the default, so the starter stays readable. */
function metaExpression(field: StarterField): string {
  const meta: string[] = [];
  if (field.isIdentity) meta.push('identity: true');
  if (field.isPrimaryDisplay) meta.push('primary: true');
  if (field.showInList === false) meta.push('list: false');
  if (field.showOnCard === true) meta.push('card: true');
  if (field.filterable === false) meta.push('filterable: false');
  return meta.length > 0 ? `.meta({ ${meta.join(', ')} })` : '';
}

function choiceValues(options: FieldOptions | null | undefined): string {
  const choices = options?.choices ?? [];
  return choices
    .map((choice) => `'${choice.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
    .join(', ');
}
