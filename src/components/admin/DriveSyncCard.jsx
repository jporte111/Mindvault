import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Cloud, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import ClientSelect from '@/components/knowledge/ClientSelect';
import { SCOPE_GENERAL, SCOPE_UNCLASSIFIED } from '@/lib/knowledgeScope';

// Sync knowledge from a Google Drive folder (transcripts, SOPs, and other
// supported text files) through the guarded syncFromDrive function.
// Shared by the company Connections page and the platform admin panel.
export default function DriveSyncCard() {
  const queryClient = useQueryClient();
  const [folderId, setFolderId] = useState('');
  const [syncScope, setSyncScope] = useState(SCOPE_UNCLASSIFIED);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    const scopeArg = syncScope === SCOPE_GENERAL
      ? { scope: 'general' }
      : syncScope.startsWith('client:')
        ? { clientId: syncScope.slice('client:'.length) }
        : {};
    const res = await base44.functions.invoke('syncFromDrive', { folderId: folderId.trim() || undefined, ...scopeArg });
    setSyncResult(res.data);
    setSyncing(false);
    if (res.data.synced > 0) {
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      toast.success(`Synced ${res.data.synced} new knowledge source${res.data.synced === 1 ? '' : 's'}!`);
    } else {
      toast.info('No new knowledge sources found.');
    }
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Cloud className="w-4 h-4 text-primary" />
          Google Drive
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Import supported files from Google Drive — .txt, .md, .vtt, .srt, and .docx.
          Imported sources start as “Needs your review” so you decide who can use each one.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">
            Google Drive folder (optional — leave blank to search all folders)
          </Label>
          <Input
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            placeholder="drive.google.com/drive/folders/FOLDER_ID"
            className="font-mono text-sm bg-background"
          />
          <p className="text-xs text-muted-foreground/70 mt-1.5">
            Find the folder ID in the Google Drive URL: drive.google.com/drive/folders/<strong>FOLDER_ID</strong>
          </p>
        </div>

        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">
            Availability for everything imported in this run
          </Label>
          <ClientSelect value={syncScope} onChange={setSyncScope} disabled={syncing} />
          <p className="text-xs text-muted-foreground/70 mt-1.5">
            “Needs review” (default) keeps imported sources out of the assistant until you
            set their availability on the Knowledge page.
          </p>
        </div>

        <Button
          onClick={handleSync}
          disabled={syncing}
          className="bg-primary hover:bg-primary/90 shadow-md shadow-primary/20 gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing...' : 'Sync now'}
        </Button>

        {syncResult && (
          <div className={`p-4 rounded-xl border text-sm ${syncResult.error ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
            {syncResult.error ? (
              <p>Error: {syncResult.error}</p>
            ) : (
              <p>
                ✓ Synced <strong>{syncResult.synced}</strong> new knowledge source(s) ·
                Skipped <strong>{syncResult.skipped}</strong> already-imported
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}