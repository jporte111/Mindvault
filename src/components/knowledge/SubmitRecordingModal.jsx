import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Upload, FileText, Loader2, CheckCircle2, X } from 'lucide-react';
import { toast } from 'sonner';
import ClientSelect from '@/components/knowledge/ClientSelect';
import { isClassified, resolveScopeFields, SCOPE_UNCLASSIFIED } from '@/lib/knowledgeScope';
import {
  SOURCE_TYPE_OPTIONS,
  SUPPORTED_UPLOAD_ACCEPT,
  SUPPORTED_UPLOAD_EXTENSIONS,
  SUPPORTED_UPLOAD_HINT,
  formatFromFilename,
} from '@/lib/knowledgeSource';

const hasSupportedExtension = (name = '') =>
  SUPPORTED_UPLOAD_EXTENSIONS.some((ext) => String(name).toLowerCase().endsWith(ext));

const UNSUPPORTED_MESSAGE = `Unsupported file type. Allowed: ${SUPPORTED_UPLOAD_EXTENSIONS.join(', ')}`;

export default function SubmitRecordingModal({ open, onClose }) {
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
  const { data: clients = [] } = useQuery({ queryKey: ['clients'], queryFn: () => base44.entities.Client.list('name') });

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

  const handleClose = () => {
    if (uploading) return;
    setTitle(''); setVideoUrl(''); setSourceFile(null);
    setStatusMsg(''); setDone(false); setScopeValue(SCOPE_UNCLASSIFIED); setSourceType('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    onClose();
  };

  const handleSubmit = async () => {
    if (!sourceFile) { toast.error('Please select a file'); return; }
    if (!title.trim()) { toast.error('Please enter a title'); return; }
    if (!sourceType) { toast.error('Please choose a knowledge type'); return; }
    if (!hasSupportedExtension(sourceFile.name)) { toast.error(UNSUPPORTED_MESSAGE); return; }

    setUploading(true);
    setDone(false);

    setStatusMsg('Uploading file...');
    const { file_url } = await base44.integrations.Core.UploadFile({ file: sourceFile });

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

    // Minimum matches the backend source resolver (resolveSourceText: 20 chars).
    if (!sourceText || sourceText.trim().length < 20) {
      toast.error('Could not extract usable text from the file. Please try a .txt file instead.');
      setUploading(false); setStatusMsg('');
      return;
    }

    setStatusMsg('Saving source text...');
    const textFile = new File([sourceText], 'source.txt', { type: 'text/plain' });
    const { file_url: sourceTextUrl } = await base44.integrations.Core.UploadFile({ file: textFile });

    // Create the knowledge source as "processing". All structured extraction is
    // done by the canonical analyzeTraining function (shared buildPass1Prompt /
    // pass1JsonSchema / buildPass2Prompt / pass2JsonSchema / ingestion-quality
    // logic / additive operational fields). No inline extraction here, and the
    // record is NOT marked ready or indexed until analysis succeeds.
    setStatusMsg('Saving to knowledge base...');
    const newRecord = await base44.entities.Training.create({
      title: title.trim(),
      transcript: sourceTextUrl,
      video_url: videoUrl.trim() || undefined,
      status: 'processing',
      source_type: sourceType,
      source_format: formatFromFilename(sourceFile.name),
      source_filename: sourceFile.name,
      ...resolveScopeFields(scopeValue, clients),
    });

    setStatusMsg('AI is analyzing the source in the background...');
    base44.functions.invoke('analyzeTraining', { trainingId: newRecord.id });

    queryClient.invalidateQueries({ queryKey: ['trainings'] });
    queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
    if (isClassified(scopeValue)) {
      toast.success('Knowledge added. Make it searchable from the "All knowledge sources" list once analysis finishes.');
    } else {
      toast.success('Knowledge added. Classify it under "Needs review" to make it searchable.');
    }
    setDone(true);
    setUploading(false);
    setStatusMsg('');
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-sora">
            <Upload className="w-5 h-5 text-primary" />
            Add Knowledge
          </DialogTitle>
        </DialogHeader>

        {done ? (
          <div className="py-8 text-center space-y-3">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto" />
            <p className="font-semibold text-foreground">Successfully added!</p>
            <p className="text-sm text-muted-foreground">Your knowledge source has been processed and added to the library.</p>
            <Button onClick={handleClose} className="mt-2">Close</Button>
          </div>
        ) : (
          <div className="space-y-4 pt-2">
            <div>
              <Label className="text-sm text-muted-foreground mb-1.5 block">Title</Label>
              <Input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Monthly Close SOP"
                className="bg-background"
                disabled={uploading}
              />
            </div>

            <div>
              <Label className="text-sm text-muted-foreground mb-1.5 block">
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
              <Label className="text-sm text-muted-foreground mb-1.5 block">
                File <span className="text-foreground font-medium">(required)</span>
              </Label>
              <div
                className="border-2 border-dashed border-border rounded-xl p-5 text-center cursor-pointer hover:border-primary/50 hover:bg-accent/30 transition-colors"
                onClick={() => !uploading && fileInputRef.current?.click()}
              >
                {sourceFile ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-foreground">
                    <FileText className="w-5 h-5 text-primary" />
                    <span className="font-medium">{sourceFile.name}</span>
                    {!uploading && (
                      <button onClick={e => { e.stopPropagation(); setSourceFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}>
                        <X className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="text-muted-foreground">
                    <Upload className="w-6 h-6 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">{SUPPORTED_UPLOAD_HINT}</p>
                  </div>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept={SUPPORTED_UPLOAD_ACCEPT} className="hidden" onChange={handleFileChange} />
            </div>

            <div>
              <Label className="text-sm text-muted-foreground mb-1.5 block">Recording URL (optional)</Label>
              <Input
                value={videoUrl}
                onChange={e => setVideoUrl(e.target.value)}
                placeholder="https://meet.google.com/recording/..."
                className="bg-background"
                disabled={uploading}
              />
            </div>

            <div>
              <Label className="text-sm text-muted-foreground mb-1.5 block">Knowledge scope</Label>
              <ClientSelect value={scopeValue} onChange={setScopeValue} disabled={uploading} />
              <p className="text-xs text-muted-foreground/70 mt-1.5">
                "Needs review" keeps this knowledge out of the chatbot until an admin classifies it.
              </p>
            </div>

            {uploading && statusMsg && (
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {statusMsg}
              </p>
            )}

            <div className="flex gap-3 pt-1">
              <Button variant="outline" onClick={handleClose} disabled={uploading} className="flex-1">
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={uploading || !sourceFile || !sourceType}
                className="flex-1 bg-primary hover:bg-primary/90 gap-2"
              >
                {uploading ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</> : <><Upload className="w-4 h-4" /> Add</>}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
