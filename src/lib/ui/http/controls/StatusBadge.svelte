<script lang="ts">
/**
 * StatusBadge: one mapping from a status vocabulary to a tone.
 *
 * Health, HTTP status codes, trigger event outcomes and run states all appear in
 * tables; sharing the mapping here means "unreachable" is never green on one page and
 * amber on another.
 */
import Badge from '$ui/primitives/Badge.svelte';

interface Props {
  status: string | number | null | undefined;
  label?: string;
  dot?: boolean;
}

let { status, label, dot = false }: Props = $props();

type Tone = 'neutral' | 'accent' | 'positive' | 'caution' | 'danger' | 'muted';

const POSITIVE = [
  'healthy',
  'ok',
  'ready',
  'success',
  'succeeded',
  'processed',
  'completed',
  'running',
  'active',
  'enabled',
  'hit',
  'stored',
  'valid'
];
const CAUTION = [
  'degraded',
  'warning',
  'caution',
  'duplicate',
  'pending',
  'queued',
  'received',
  'conditional'
];
const DANGER = ['unreachable', 'failed', 'failure', 'error', 'invalid', 'disabled', 'cancelled'];
const MUTED = ['unknown', 'never', 'none', 'ignored', 'bypass'];

function toneFor(value: string | number | null | undefined): Tone {
  if (value === null || value === undefined || value === '') return 'muted';
  if (typeof value === 'number') {
    if (value >= 200 && value < 400) return 'positive';
    if (value >= 400 && value < 500) return 'caution';
    if (value >= 500) return 'danger';
    return 'neutral';
  }
  const normalized = value.toLowerCase();
  if (POSITIVE.includes(normalized)) return 'positive';
  if (CAUTION.includes(normalized)) return 'caution';
  if (DANGER.includes(normalized)) return 'danger';
  if (MUTED.includes(normalized)) return 'muted';
  if (/^\d{3}$/.test(normalized)) return toneFor(Number(normalized));
  return 'neutral';
}

const tone = $derived(toneFor(status));
const text = $derived(
  label ?? (status === null || status === undefined || status === '' ? 'none' : String(status))
);
</script>

<Badge {tone} {dot}>{text}</Badge>
