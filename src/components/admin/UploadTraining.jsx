import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Upload, FileText, Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/AuthContext';
import ClientSelect from '@/components/knowledge/ClientSelect';
import { isClassified, resolveScopeFields, SCOPE_UNCLASSIFIED } from '@/lib/knowledgeScope';
import { recordAppAction, recordAppError, clearRecentAppError } from '@/lib/supportContext';
import {
  SOURCE_TYPE_OPTIONS,
  SUPPORTED_UPLOAD_ACCEPT,
  SUPPORTED_UPLOAD_EXTENSIONS,
  SUPPORTED_UPLOAD_HINT,
  formatFromFilename,
} from '@/lib/knowledgeSource';
import { listMyClients } from '@/lib/scopedData';

const hasSupportedExtension = (name = '') =>
  SUPPORTED_UPLOAD_EXTENSIONS.some((ext) => String(name).toLowerCase().endsWith(ext));

const UNSUPPORTED_MESSAGE = `Unsupported file type. Allowed: ${SUPPORTED_UPLOAD_EXTENSIONS.join(', ')}`;

export default function UploadTraining() {
  const [title, setTitle] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [sourceFile, setSourceFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [done, setDone] = useState(false);
  const [scopeValue, setScopeValue] = useState(SCOPE_UNCLASSIFIED);
  const [sourceType, setSourceType] = useState('');
  const fileInputRef = useRef();
  const queryClient = useQueryClient();
  const { data: clients = [] } = useQuery({ queryKey: ['clients'], queryFn: () => listMyClients() });

  // A platform Super Admin must choose which team's workspace this upload
  // targets — the backend requires an explicit tenant for the write.
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'admin';
  const [tenantId, setTenantId] = useState('');
  const { data: tenants = [] } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => base44.entities.Tenant.list('name'),
    enabled: isSuperAdmin,
  });
  useEffect(() => {
    if (isSuperAdmin && !tenantId && tenants.length) setTenantId(tenants[0].id);
  }, [isSuperAdmin, tenants, tenantId]);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // The accept attribute is only a picker hint — reject unsupported files hard.
    if (!hasSupportedExtension(file.name)) {
      toast.error(UNSUPPORTED_MESSAGE);
      setSourceFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setSourceFile(file);
    if (!title) setTitle(file.name.replace(/\.[^/.]+$/, ''));
  };

  const handleSubmit = async () => {
    if (!sourceFile) { toast.error('Please select a file'); return; }
    if (!title.trim()) { toast.error('Please enter a title'); return; }
    if (!sourceType) { toast.error('Please choose a knowledge type'); return; }
    if (isSuperAdmin && !tenantId) { toast.error('Choose which team this knowledge belongs to'); return; }
    if (!hasSupportedExtension(sourceFile.name)) { toast.error(UNSUPPORTED_MESSAGE); return; }

    setUploading(true);
    setDone(false);

    try {
    // 1. Upload the file
    setStatusMsg('Uploading file...');
    const { file_url } = await base44.integrations.Core.UploadFile({ file: sourceFile });

    // 2. Extract text
    setStatusMsg('Extracting text...');
    let sourceText = '';
    const fileName = sourceFile.name.toLowerCase();
    if (fileName.endsWith('.docx')) {
      const res = await base44.functions.invoke('extractDocxText', { file_url });
      sourceText = res.data?.text || '';
    } else {
      const textRes = await fetch(file_url);
      sourceText = await textRes.text();
    }

    // Minimum matches the backend source resolver (resolveSourceText: 20 chars),
    // so valid short checklists / process notes are not rejected here.
    if (!sourceText || sourceText.trim().length < 20) {
      toast.error('Could not extract usable text from the file. Please try a .txt file instead.');
      setUploading(false);
      setStatusMsg('');
      return; // finally-block still runs
    }

    // 3. Upload extracted text as the source-text file
    setStatusMsg('Saving source text...');
    const textFile = new File([sourceText], 'source.txt', { type: 'text/plain' });
    const { file_url: sourceTextUrl } = await base44.integrations.Core.UploadFile({ file: textFile });

    // 4. Create the knowledge source via the guarded backend function, which
    // stamps the VERIFIED tenant server-side (never the client payload).
    setStatusMsg('Saving to knowledge base...');
    const createRes = await base44.functions.invoke('createKnowledgeSource', {
      action: 'create',
      ...(isSuperAdmin ? { tenant_id: tenantId } : {}),
      fields: {
        title: title.trim(),
        transcript: sourceTextUrl,
        video_url: videoUrl.trim() || undefined,
        source_type: sourceType,
        source_format: formatFromFilename(sourceFile.name),
        source_filename: sourceFile.name,
        ...resolveScopeFields(scopeValue, clients),
      },
    });
    const newRecord = createRes?.data?.training ?? createRes?.training;
    if (!newRecord?.id) {
      throw new Error('Could not save the knowledge source. Please try again.');
    }

    // 5. Kick off backend analysis (non-blocking — resolves in background)
    setStatusMsg('AI is analyzing the source in the background...');
    base44.functions.invoke('analyzeTraining', { trainingId: newRecord.id });

    queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
    queryClient.invalidateQueries({ queryKey: ['trainings'] });
    clearRecentAppError();
    recordAppAction({ action: 'add a knowledge source', page: 'Manage', section: 'Add knowledge' });
    if (isClassified(scopeValue)) {
      toast.success('Knowledge added. Index it for chat from "All Trainings" once analysis finishes.');
    } else {
      toast.success('Knowledge added. Classify it under "Needs review" to make it searchable.');
    }
    setDone(true);
    setTitle('');
    setVideoUrl('');
    setSourceFile(null);
    setScopeValue(SCOPE_UNCLASSIFIED);
    setSourceType('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (e) {
      // Recent error context for MindVault Help — short message + code only,
      // no tenant id, no response payload, no stack trace.
      const message = e?.response?.data?.error || e?.message || 'Could not add the knowledge source';
      recordAppError({
        action: 'add a knowledge source',
        page: 'Manage',
        section: 'Add knowledge',
        error: message,
        code: e?.response?.status || e?.status,
      });
      toast.error(message);
    } finally {
      setStatusMsg('');
      setUploading(false);
    }
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Upload className="w-4 h-4 text-primary" />
          Add Knowledge Manually
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isSuperAdmin && (
          <div>
            <Label className="text-sm text-muted-foreground mb-2 block">Team this knowledge belongs to</Label>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              disabled={uploading}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              aria-label="Team this knowledge belongs to"
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground/70 mt-1.5">
              You're a platform admin — uploads must target a specific team's workspace.
            </p>
          </div>
        )}
        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">Title</Label>
          <Input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Monthly Close SOP"
            className="bg-background"
          />
        </div>

        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">
            Knowledge type <span className="text-foreground font-medium">(required)</span>
          </Label>
          <select
            value={sourceType}
            onChange={e => setSourceType(e.target.value)}
            disabled={uploading}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <option value="" disabled>Choose a type…</option>
            {SOURCE_TYPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">
            File <span className="text-foreground font-medium">(required)</span>
          </Label>
          <div
            className="border-2 border-dashed border-border rounded-xl p-6 text-center cursor-pointer hover:border-primary/50 hover:bg-accent/30 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            {sourceFile ? (
              <div className="flex items-center justify-center gap-2 text-sm text-foreground">
                <FileText className="w-5 h-5 text-primary" />
                <span className="font-medium">{sourceFile.name}</span>
              </div>
            ) : (
              <div className="text-muted-foreground">
                <Upload className="w-6 h-6 mx-auto mb-2 opacity-50" />
                <p className="text-sm">{SUPPORTED_UPLOAD_HINT}</p>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={SUPPORTED_UPLOAD_ACCEPT}
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">Recording URL (optional)</Label>
          <Input
            value={videoUrl}
            onChange={e => setVideoUrl(e.target.value)}
            placeholder="https://meet.google.com/recording/..."
            className="bg-background"
          />
        </div>

        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">Knowledge scope</Label>
          <ClientSelect value={scopeValue} onChange={setScopeValue} disabled={uploading} />
          <p className="text-xs text-muted-foreground/70 mt-1.5">
            Controls which chat contexts can retrieve this knowledge. Left as "Needs review", it stays out of the chatbot until classified.
          </p>
        </div>

        <Button
          onClick={handleSubmit}
          disabled={uploading || !sourceFile || !sourceType}
          className="bg-primary hover:bg-primary/90 shadow-md shadow-primary/20 gap-2"
        >
          {uploading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
          ) : done ? (
            <><CheckCircle2 className="w-4 h-4" /> Added!</>
          ) : (
            <><Upload className="w-4 h-4" /> Add & Process</>
          )}
        </Button>
        {uploading && statusMsg && (
          <p className="text-xs text-muted-foreground">{statusMsg}</p>
        )}
      </CardContent>
    </Card>
  );
}