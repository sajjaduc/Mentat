/**
 * Tool-catalogue components shared by the `/tools` page and the skill editor's
 * recommended-tool picker. Kept in the agents namespace because they speak the
 * agent/skill/tool vocabulary rather than the generic HTTP editor one.
 */

export { groupByNamespace, namespaceForKey } from './namespaces';
export { default as ParameterList } from './ParameterList.svelte';
export { default as PolicySummary } from './PolicySummary.svelte';
