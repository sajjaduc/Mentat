/**
 * Toast state.
 *
 * A single rune-backed list, deliberately tiny: toasts are for "something
 * happened", not for state that the UI depends on. Errors that require action are
 * rendered inline instead (see ErrorState).
 */
export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  /** Milliseconds; 0 keeps it until dismissed. */
  timeoutMs: number;
}

let nextId = 1;
const items: Toast[] = $state([]);

export const toasts = {
  get current(): Toast[] {
    return items;
  }
};

export function pushToast(input: Omit<Toast, 'id' | 'timeoutMs'> & { timeoutMs?: number }): number {
  const id = nextId++;
  const toast: Toast = {
    id,
    tone: input.tone,
    title: input.title,
    description: input.description,
    timeoutMs: input.timeoutMs ?? (input.tone === 'error' ? 8000 : 3500)
  };
  items.push(toast);
  if (toast.timeoutMs > 0) {
    setTimeout(() => dismissToast(id), toast.timeoutMs);
  }
  return id;
}

export function dismissToast(id: number): void {
  const index = items.findIndex((toast) => toast.id === id);
  if (index >= 0) items.splice(index, 1);
}

export function clearToasts(): void {
  items.length = 0;
}
