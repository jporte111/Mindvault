import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, Loader2, Archive, ArchiveRestore } from 'lucide-react';
import { toast } from 'sonner';
import DeleteClientButton from '@/components/admin/DeleteClientButton';
import { listKnowledgeSources, listMyClients, manageClient } from '@/lib/scopedData';
import { useIsAdmin } from '@/hooks/useIsAdmin';

// Client list management — add, archive/restore, and delete the clients
// that client-specific knowledge can be scoped to. Shared by the company
// Knowledge page and the platform admin panel.
export default function ClientsCard() {
  const queryClient = useQueryClient();
  const isPlatformAdmin = useIsAdmin();
  const [newClient, setNewClient] = useState('');
  const [addingClient, setAddingClient] = useState(false);

  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: () => listMyClients(),
  });
  const { data: trainings = [] } = useQuery({
    queryKey: ['all-trainings'],
    queryFn: () => listKnowledgeSources({ sort: '-created_date' }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
    queryClient.invalidateQueries({ queryKey: ['trainings'] });
    queryClient.invalidateQueries({ queryKey: ['clients'] });
  };

  const addClient = async () => {
    const name = newClient.trim();
    if (!name) return;
    setAddingClient(true);
    try {
      await manageClient({ action: 'create', name });
      setNewClient('');
      invalidate();
      toast.success(`Client "${name}" added`);
    } catch (err) {
      toast.error('Failed to add client: ' + (err?.message || 'Unknown error'));
    } finally {
      setAddingClient(false);
    }
  };

  const toggleArchive = async (client) => {
    try {
      await manageClient({
        action: 'update',
        clientId: client.id,
        status: client.status === 'archived' ? 'active' : 'archived',
      });
      invalidate();
    } catch (err) {
      toast.error('Failed to update client: ' + (err?.message || 'Unknown error'));
    }
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Users className="w-4 h-4 text-primary" />
          Clients
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Client-specific knowledge is only used when the assistant is answering in that
          client&apos;s context.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={newClient}
            onChange={(e) => setNewClient(e.target.value)}
            placeholder="New client name"
            className="flex-1 bg-background"
            onKeyDown={(e) => { if (e.key === 'Enter' && !addingClient) addClient(); }}
          />
          <Button onClick={addClient} disabled={addingClient || !newClient.trim()} className="bg-primary hover:bg-primary/90 gap-2">
            {addingClient ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
            Add
          </Button>
        </div>
        {clients.length > 0 && (
          <div className="divide-y divide-border border border-border rounded-xl">
            {clients.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 text-sm text-foreground truncate">{c.name}</span>
                {c.status === 'archived' && <Badge variant="outline" className="text-xs text-muted-foreground">Archived</Badge>}
                {/* Legacy clients without a workspace are managed by platform admins only (the server refuses others). */}
                {!c.tenant_id && !isPlatformAdmin ? (
                  <Badge variant="outline" className="text-xs text-muted-foreground">Shared (legacy)</Badge>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground" onClick={() => toggleArchive(c)}>
                      {c.status === 'archived' ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                      {c.status === 'archived' ? 'Restore' : 'Archive'}
                    </Button>
                    <DeleteClientButton
                      client={c}
                      // Same rule as the server: any source referencing the client blocks deletion.
                      linkedCount={trainings.filter((t) => t.client_id === c.id).length}
                      onDeleted={invalidate}
                    />
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}