<script lang="ts">
/**
 * The Zod → field mapping reference for schema authors.
 *
 * Object Type, workflow overlay and state schemas are all authored as Zod source
 * and projected onto the typed-field engine. This guide shows every construct the
 * projector understands, how `.meta()` binds identity/display behaviour, and how
 * the three layers stack — so an author can define everything from the schema box
 * without a second field form.
 *
 * The content is data from `zod-field-mapping.ts`, pinned against the real
 * projector by a unit test, so the page cannot describe a mapping the engine no
 * longer performs.
 */
import Badge from '$ui/primitives/Badge.svelte';
import Card from '$ui/primitives/Card.svelte';
import {
  ZOD_CONSTRAINT_MAPPINGS,
  ZOD_KEY_RULES,
  ZOD_LAYER_EXAMPLE,
  ZOD_LAYERS,
  ZOD_MAPPING_GROUPS,
  ZOD_META_EXAMPLE,
  ZOD_META_FLAGS
} from '$ui/schema/zod-field-mapping';

interface Props {
  /** Render expanded on first paint. Defaults to false. */
  open?: boolean;
  class?: string;
}

let { open = false, class: className = '' }: Props = $props();
</script>

<Card padding="md" class={className}>
  <details open={open} data-testid="zod-field-mapping-guide">
    <summary
      class="cursor-pointer list-none text-sm font-medium text-[var(--color-ink)] marker:content-none"
    >
      <span class="inline-flex items-center gap-2">
        Zod → field mapping reference
        <span class="text-[11px] font-normal text-[var(--color-ink-subtle)]">
          (what each construct creates, and how `primary` works)
        </span>
      </span>
    </summary>

    <div class="mt-3 space-y-5">
      <p class="text-xs text-[var(--color-ink-muted)]">
        A schema is the contract and the field list is its projection. Author everything here — the
        typed fields, their choices, their requiredness, and their identity/display behaviour — and
        the record lists, filters and history follow automatically.
      </p>

      <!-- Layers -->
      <section class="space-y-2">
        <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
          How the layers stack
        </h3>
        <ul class="space-y-2">
          {#each ZOD_LAYERS as layer (layer.id)}
            <li
              class="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] p-2.5"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs font-medium text-[var(--color-ink)]">{layer.title}</span>
                <span class="font-mono text-[11px] text-[var(--color-ink-subtle)]"
                  >{layer.where}</span
                >
                {#if layer.id === 'object-type'}<Badge tone="accent">always checked</Badge>{/if}
              </div>
              <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
                {layer.effect}
              </p>
            </li>
          {/each}
        </ul>
        <pre
          class="overflow-auto rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--color-ink-muted)]">{ZOD_LAYER_EXAMPLE}</pre>
        <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
          The Object Type schema is the floor: it is part of every workflow contract and is checked on
          every write, whether that is an AI submission, a record tool call or an edit in the record
          editor. Overlays and state schemas add to it. A key redeclared in an overlay is combined
          with the base definition, so an overlay can only tighten a field — it can never loosen a
          constraint the base declares.
        </p>
      </section>

      <!-- Primary + meta -->
      <section class="space-y-2">
        <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
          How <span class="font-mono normal-case">primary</span> works
        </h3>
        <div
          class="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)]/50 p-2.5"
        >
          <p class="text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
            The <span class="font-mono">primary</span> field supplies the record’s display name: when
            it has a value the record is labelled with that value, and the label is recomputed when
            the field changes. If no field sets <span class="font-mono">primary</span>, the
            <strong>first field in the schema</strong> becomes primary. Put
            <span class="font-mono">primary: false</span> on the first field to opt out and leave the
            records unlabelled (<span class="font-mono">Untitled &lt;Object Type&gt;</span>). When more
            than one field sets <span class="font-mono">primary: true</span>, the first in schema
            order wins. The test result above shows <span class="font-mono">primary</span> only when
            it is declared; the automatic first-field pick is applied when you save.
          </p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="text-[11px] text-[var(--color-ink-subtle)]">
                <th class="py-1 pr-3 font-medium">.meta() key</th>
                <th class="py-1 pr-3 font-medium">Binding</th>
                <th class="py-1 pr-3 font-medium">When omitted</th>
                <th class="py-1 font-medium">Effect</th>
              </tr>
            </thead>
            <tbody>
              {#each ZOD_META_FLAGS as flag (flag.key)}
                <tr class="border-t border-[var(--color-border-subtle)] align-top">
                  <td class="py-1.5 pr-3">
                    <span class="font-mono text-[11px] text-[var(--color-ink)]">{flag.key}</span>
                  </td>
                  <td class="py-1.5 pr-3 font-mono text-[11px] text-[var(--color-ink-subtle)]">
                    {flag.binding}
                  </td>
                  <td class="py-1.5 pr-3 text-[11px] text-[var(--color-ink-subtle)]">
                    {flag.fallback}
                  </td>
                  <td class="py-1.5 text-[11px] text-[var(--color-ink-muted)]">
                    {flag.effect}
                    <span class="mt-0.5 block font-mono text-[10px] text-[var(--color-ink-subtle)]"
                      >.meta({ '{' }{flag.example}{'}' })</span
                    >
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <pre
          class="overflow-auto rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--color-ink-muted)]">{ZOD_META_EXAMPLE}</pre>
      </section>

      <!-- Construct mapping -->
      <section class="space-y-3">
        <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
          What each Zod construct becomes
        </h3>
        {#each ZOD_MAPPING_GROUPS as group (group.id)}
          <div class="space-y-1.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-medium text-[var(--color-ink)]">{group.title}</span>
            </div>
            <p class="text-[11px] text-[var(--color-ink-subtle)]">{group.description}</p>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead>
                  <tr class="text-[11px] text-[var(--color-ink-subtle)]">
                    <th class="py-1 pr-3 font-medium">Zod</th>
                    <th class="py-1 pr-3 font-medium">Field</th>
                    <th class="py-1 pr-3 font-medium">Required</th>
                    <th class="py-1 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {#each group.rows as row (row.zod)}
                    <tr class="border-t border-[var(--color-border-subtle)] align-top">
                      <td class="py-1.5 pr-3">
                        <span class="font-mono text-[11px] text-[var(--color-ink)]">{row.zod}</span>
                      </td>
                      <td class="py-1.5 pr-3">
                        <Badge tone={row.fieldType === 'json' ? 'muted' : 'accent'}>
                          {row.fieldType}
                        </Badge>
                        {#if row.choices !== undefined}
                          <span class="ml-1 text-[10px] text-[var(--color-ink-subtle)]"
                            >{row.choices} choice{row.choices === 1 ? '' : 's'}</span
                          >
                        {/if}
                      </td>
                      <td class="py-1.5 pr-3">
                        <Badge tone={row.required ? 'neutral' : 'muted'}>
                          {row.required ? 'required' : 'optional'}
                        </Badge>
                      </td>
                      <td class="py-1.5 text-[11px] text-[var(--color-ink-muted)]">{row.note}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/each}
      </section>

      <!-- Constraints -->
      <section class="space-y-2">
        <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
          Constraints carried into the field engine
        </h3>
        <p class="text-[11px] text-[var(--color-ink-subtle)]">
          These constraints become typed field validation, so the record editor, filters and agents
          all see them. Anything else still runs from the source at validation time.
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <tbody>
              {#each ZOD_CONSTRAINT_MAPPINGS as row (row.zod)}
                <tr class="border-t border-[var(--color-border-subtle)]">
                  <td class="py-1.5 pr-3 font-mono text-[11px] text-[var(--color-ink)]">{row.zod}</td>
                  <td class="py-1.5 text-[11px] text-[var(--color-ink-muted)]">{row.projected}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <!-- Keys -->
      <section class="space-y-2">
        <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
          Field keys
        </h3>
        <ul class="list-disc space-y-1 pl-4 text-[11px] text-[var(--color-ink-muted)]">
          {#each ZOD_KEY_RULES as rule (rule)}
            <li>{rule}</li>
          {/each}
        </ul>
      </section>
    </div>
  </details>
</Card>
