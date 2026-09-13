import { useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

// Permanently deletes a client record. Safety rule: if any knowledge is
// currently classified as client-specific to this client, deletion is
// blocked — that knowledge would become unreachable, so it must be
// reclassified or archived first.
export default function DeleteClientButton({ client, linkedCount, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const blocked = linkedCount > 0;

  const doDelete = async () => {
    setBusy(true);
    try {
      await base44.entities.Client.delete(client.id);
      toast.success(`Client "${client.name}" deleted`);
      onDeleted?.();
    } catch (err) {
      toast.error('Failed to delete client: ' + (err?.message || 'Unknown error'));
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
          disabled={busy}
          aria-label={`Delete ${client.name}`}
        >
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{blocked ? 'Client can\u2019t be deleted yet' : `Delete "${client.name}"?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? `${linkedCount} knowledge ${linkedCount === 1 ? 'item is' : 'items are'} currently classified for this client and would become unreachable. Reclassify or archive that knowledge first, then delete the client.`
              : 'This permanently removes the client from your list. Knowledge classified for this client must be reclassified or archived first — none currently is. This can\u2019t be undone.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{blocked ? 'Close' : 'Cancel'}</AlertDialogCancel>
          {!blocked && (
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                doDelete();
              }}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Delete permanently'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}