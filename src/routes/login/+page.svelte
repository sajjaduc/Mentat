<script lang="ts">
/**
 * Sign in / create the first account.
 *
 * One screen for both because a fresh local install has no accounts: when the
 * instance is empty the form creates the owner account and its starter workspace.
 * Errors are inline and specific; the panel is deliberately calm and narrow.
 */
import { goto } from '$app/navigation';
import { api, describeApiError } from '$ui/api';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';

let { data } = $props();

let mode = $state<'login' | 'register'>(data.needsSetup ? 'register' : 'login');
let email = $state('');
let name = $state('');
let password = $state('');
let busy = $state(false);
let error = $state<string | null>(null);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  error = null;
  try {
    if (mode === 'register') {
      await api.post('/auth/register', { email, name, password });
    } else {
      await api.post('/auth/login', { email, password });
    }
    const next = new URLSearchParams(location.search).get('next');
    await goto(next?.startsWith('/') ? next : '/workflows');
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    busy = false;
  }
}
</script>

<svelte:head><title>Sign in · Mentat</title></svelte:head>

<div class="flex min-h-screen items-center justify-center bg-[var(--color-canvas)] px-4">
  <div class="w-full max-w-sm space-y-6">
    <div class="space-y-1.5 text-center">
      <span class="mx-auto flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent)] text-sm font-bold text-white">M</span>
      <h1 class="text-lg font-semibold tracking-tight">Mentat</h1>
      <p class="text-xs text-[var(--color-ink-subtle)]">
        {mode === 'register' ? 'Create the first account for this instance.' : 'Sign in to your workspace.'}
      </p>
    </div>

    <form class="space-y-4 rounded-[var(--radius-xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)]" onsubmit={submit}>
      {#if mode === 'register'}
        <Input label="Your name" bind:value={name} autocomplete="name" required placeholder="Ada Lovelace" />
      {/if}
      <Input label="Email" type="email" bind:value={email} autocomplete="email" required placeholder="you@example.com" />
      <Input
        label="Password"
        type="password"
        bind:value={password}
        autocomplete={mode === 'register' ? 'new-password' : 'current-password'}
        required
        hint={mode === 'register' ? 'At least 10 characters.' : undefined}
      />

      {#if error}
        <p class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-danger)_10%,transparent)] px-3 py-2 text-xs text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      {/if}

      <Button type="submit" variant="primary" loading={busy} class="w-full justify-center">
        {mode === 'register' ? 'Create account' : 'Sign in'}
      </Button>

      {#if !data.signupDisabled}
        <button
          type="button"
          class="w-full text-center text-xs text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
          onclick={() => {
            modeOverride = mode === 'login' ? 'register' : 'login';
            error = null;
          }}
        >
          {mode === 'login' ? 'Create the first account' : 'I already have an account'}
        </button>
      {/if}
    </form>

    <p class="text-center text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
      Mentat runs locally. Data lives in <code class="font-mono">./data/mentat.db</code> and files in
      <code class="font-mono">./data/blobs</code>.
    </p>
  </div>
</div>
