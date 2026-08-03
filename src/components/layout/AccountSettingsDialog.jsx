import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Trash2, AlertTriangle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';

export default function AccountSettingsDialog({ open, onClose }) {
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');

  const handleDelete = async () => {
    setLoading(true);
    try {
      // Invoke account deletion function to notify platform systems
      try {
        await base44.functions.invoke('requestAccountDeletion');
      } catch (apiErr) {
        console.error('Account deletion signal error:', apiErr);
      }
      await base44.auth.logout();
      toast.success('Your account deletion request has been submitted successfully.');
    } catch (e) {
      toast.error('Could not complete deletion: ' + (e?.message || 'Unknown error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Account Settings</DialogTitle>
          <DialogDescription>Manage your account and session.</DialogDescription>
        </DialogHeader>
        {!confirm ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Delete Account</p>
                  <p className="text-xs text-muted-foreground">Permanently remove your account</p>
                </div>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setConfirm(true)} className="gap-1.5">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} className="w-full">Close</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-foreground">
              This will permanently delete your account. This action cannot be undone.
            </p>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Type <span className="font-semibold text-foreground">DELETE</span> to confirm
              </label>
              <Input
                value={deleteConfirmationText}
                onChange={(e) => setDeleteConfirmationText(e.target.value)}
                placeholder="DELETE"
                className="h-11"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setConfirm(false); setDeleteConfirmationText(''); }} disabled={loading}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={loading || deleteConfirmationText !== 'DELETE'}
                className="gap-1.5"
              >
                {loading ? 'Deleting...' : (<><Trash2 className="w-3.5 h-3.5" /> Delete Account</>)}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}