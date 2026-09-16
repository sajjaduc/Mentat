<script lang="ts">
/**
 * PolicySummary: the plain-language enforcement story for a stored tool.
 *
 * Approval is enforced by Mentat before the call leaves the process, and caching is
 * decided by the runtime too — neither is something the model can opt out of. Showing
 * both here, using the same `describe*` helpers the HTTP editor uses, is what keeps the
 * tool catalogue from contradicting the editor about what will actually happen.
 */
import { describeApprovalPolicy, describeCachePolicy } from '$ui/http/policy';
import type { ApprovalPolicy, CachePolicy } from '$ui/http/types';

interface Props {
  approval?: ApprovalPolicy | null;
  cache?: CachePolicy | null;
}

let { approval = null, cache = null }: Props = $props();

const approvalText = $derived(describeApprovalPolicy(approval));
const cacheText = $derived(describeCachePolicy(cache));
</script>

<dl class="grid gap-2 text-xs sm:grid-cols-2">
  <div class="space-y-0.5">
    <dt class="font-medium text-[var(--color-ink-muted)]">Approval</dt>
    <dd class="leading-relaxed text-[var(--color-ink-subtle)]">{approvalText}</dd>
  </div>
  <div class="space-y-0.5">
    <dt class="font-medium text-[var(--color-ink-muted)]">Cache</dt>
    <dd class="leading-relaxed text-[var(--color-ink-subtle)]">{cacheText}</dd>
  </div>
</dl>
