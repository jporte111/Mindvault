import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { 
  RefreshCw, Trash2, FolderOpen, CheckCircle2, AlertCircle, 
  Clock, BookOpen, Settings, CloudOff, Cloud
} from 'lucide-react';
import { toast } from 'sonner';

export default function Admin() {
  const [folderId, setFolderId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [driveConnected, setDriveConnected] = useState(true);

  const queryClient = useQueryClient();

  const { data: trainings = [], isLoading } = useQuery({
    queryKey: ['all-trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Training.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      toast.success('Training deleted');
    },
    onError: (err) => toast.error('Failed to delete: ' + err.message),
  });

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    const res = await base44.functions.invoke('syncFromDrive', { folderId: folderId.trim() || undefined });
    setSyncResult(res.data);
    setSyncing(false);
    if (res.data.synced > 0) {
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      toast.success(`Synced ${res.data.synced} new training(s)!`);
    } else {
      toast.info('No new trainings found.');
    }
  };

  const statusConfig = {
    ready: { icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50 border-green-200', label: 'Ready' },
    processing: { icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200', label: 'Processing' },
    error: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-50 border-red-200', label: 'Error' },
  };

  const stats = {
    total: trainings.length,
    ready: trainings.filter(t => t.status === 'ready').length,
    processing: trainings.filter(t => t.status === 'processing').length,
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-card border-b border-border px-8 py-8">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Settings className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="font-sora text-2xl font-bold text-foreground">Admin Panel</h1>
            <p className="text-muted-foreground text-sm">Manage your knowledge base content</p>
          </div>
        </div>
      </div>

      <div className="px-8 py-8 max-w-5xl mx-auto space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Total Trainings', value: stats.total, icon: BookOpen },
            { label: 'Ready', value: stats.ready, icon: CheckCircle2 },
            { label: 'Processing', value: stats.processing, icon: Clock },
          ].map(({ label, value, icon: Icon }) => (
            <Card key={label} className="border-border">
              <CardContent className="p-5 flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Icon className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-sora font-bold text-foreground">{value}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Sync Card */}
        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Cloud className="w-4 h-4 text-primary" />
              Sync from Google Drive
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm text-muted-foreground mb-2 block">
                Google Drive Folder ID (optional — leave blank to search all transcript files)
              </Label>
              <Input
                value={folderId}
                onChange={e => setFolderId(e.target.value)}
                placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs"
                className="font-mono text-sm bg-background"
              />
              <p className="text-xs text-muted-foreground/70 mt-1.5">
                Find your folder ID in the Google Drive URL: drive.google.com/drive/folders/<strong>FOLDER_ID</strong>
              </p>
            </div>

            <Button
              onClick={handleSync}
              disabled={syncing}
              className="bg-primary hover:bg-primary/90 shadow-md shadow-primary/20 gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Now'}
            </Button>

            {syncResult && (
              <div className={`p-4 rounded-xl border text-sm ${syncResult.error ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
                {syncResult.error ? (
                  <p>Error: {syncResult.error}</p>
                ) : (
                  <p>
                    ✓ Synced <strong>{syncResult.synced}</strong> new training(s) · 
                    Skipped <strong>{syncResult.skipped}</strong> already-imported
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Training List */}
        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" />
              All Trainings
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-12 bg-muted rounded-xl animate-pulse" />
                ))}
              </div>
            ) : trainings.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-30" />
                <p>No trainings yet. Sync from Google Drive to get started.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {trainings.map(training => {
                  const cfg = statusConfig[training.status] || statusConfig.ready;
                  const StatusIcon = cfg.icon;
                  return (
                    <div key={training.id} className="flex items-center gap-4 px-5 py-4 hover:bg-muted/30 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{training.title}</p>
                        <p className="text-xs text-muted-foreground">{training.category || 'Uncategorized'} · {training.presenter || 'Unknown presenter'}</p>
                      </div>
                      <Badge variant="outline" className={`text-xs border ${cfg.bg} ${cfg.color} gap-1 flex-shrink-0`}>
                        <StatusIcon className="w-3 h-3" />
                        {cfg.label}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive flex-shrink-0 h-8 w-8 p-0"
                        onClick={() => deleteMutation.mutate(training.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}