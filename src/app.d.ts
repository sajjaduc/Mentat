// See https://svelte.dev/docs/kit/types#app.d.ts
import type { ActorContext } from '$server/core/context';

declare global {
  namespace App {
    interface Locals {
      /** Populated by `hooks.server.ts` for every request. */
      actor: ActorContext | null;
      userId: string | null;
      sessionId: string | null;
      /** Workspace resolved from the URL/route for this request. */
      workspaceId: string | null;
      requestId: string;
    }

    interface PageData {
      actor?: {
        userId: string | null;
        name: string | null;
        email: string | null;
        role: string | null;
        isPlatformAdmin: boolean;
      } | null;
      workspace?: { id: string; name: string; slug: string } | null;
      workspaces?: Array<{ id: string; name: string; slug: string; role: string }>;
      flash?: { kind: 'success' | 'error' | 'info'; message: string } | null;
    }

    interface Error {
      code?: string;
      requestId?: string;
      details?: Record<string, unknown>;
    }
  }
}
