<script lang="ts">
/**
 * Ticket drawer.
 *
 * A thin wrapper so opening a ticket never navigates: the drawer renders in place,
 * the URL carries `?ticket=` and the surface below owns all data and mutations.
 */
import Drawer from '$ui/primitives/Drawer.svelte';
import TicketSurface from '$ui/ticket/TicketSurface.svelte';

interface Props {
  ticketId: string;
  workspaceId?: string;
  onclose: () => void;
  onOpenTicket: (ticketId: string) => void;
  onTransferred?: () => void;
}

let { ticketId, workspaceId = '', onclose, onOpenTicket, onTransferred }: Props = $props();
</script>

<Drawer open={true} title="Ticket detail" width="48rem" onclose={onclose}>
  <TicketSurface {ticketId} {workspaceId} variant="drawer" {onOpenTicket} {onTransferred} />
</Drawer>
