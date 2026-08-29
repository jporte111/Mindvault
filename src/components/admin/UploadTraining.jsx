import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Upload, FileText, Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import ClientSelect from '@/components/knowledge/ClientSelect';
import { isClassified, resolveScopeFields, SCOPE_UNCLASSIFIED } from '@/lib/knowledgeScope';

export default function UploadTraining() {
  const [title, setTitle] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [transcriptFile, setTranscriptFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [done, setDone] = useState(false);
  const [scopeValue, setScopeValue] = useState(SCOPE_UNCLASSIFIED);
  const fileInputRef = useRef();
  const queryClient = useQueryClient();
  const { data: clients = [] } = useQuery({ queryKey: ['clients'], queryFn: () => base44.entities.Client.list('name') });

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setTranscriptFile(file);
      if (!title) setTitle(file.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleSubmit = async () => {
    if (!transcriptFile) { toast.error('Please select a transcript file'); return; }
    if (!title.trim()) { toast.error('Please enter a title'); return; }

    setUploading(true);
    setDone(false);

    // 1. Upload the file
    setStatusMsg('Uploading file...');
    const { file_url } = await base44.integrations.Core.UploadFile({ file: transcriptFile });

    // 2. Extract text
    setStatusMsg('Extracting transcript text...');
    let transcript = '';
    const fileName = transcriptFile.name.toLowerCase();
    if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
      const res = await base44.functions.invoke('extractDocxText', { file_url });
      transcript = res.data?.text || '';
    } else if (fileName.endsWith('.pdf')) {
      const extracted = await base44.integrations.Core.ExtractDataFromUploadedFile({
        file_url,
        json_schema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The full text content of the document' } }
        }
      });
      transcript = extracted?.output?.text || '';
    } else {
      const textRes = await fetch(file_url);
      transcript = await textRes.text();
    }

    if (!transcript || transcript.trim().length < 50) {
      toast.error('Could not extract text from the file. Please try a .txt file instead.');
      setUploading(false);
      setStatusMsg('');
      return;
    }

    // 3. Upload extracted text
    setStatusMsg('Saving transcript...');
    const textFile = new File([transcript], 'transcript.txt', { type: 'text/plain' });
    const { file_url: transcriptFileUrl } = await base44.integrations.Core.UploadFile({ file: textFile });

    // 4. Create Training record immediately with processing status
    setStatusMsg('Saving to knowledge base...');
    const newRecord = await base44.entities.Training.create({
      title: title.trim(),
      transcript: transcriptFileUrl,
      video_url: videoUrl.trim() || undefined,
      status: 'processing',
      ...resolveScopeFields(scopeValue, clients),
    });

    // 5. Kick off backend analysis (non-blocking — resolves in background)
    setStatusMsg('AI is analyzing the transcript in the background...');
    base44.functions.invoke('analyzeTraining', { trainingId: newRecord.id });

    queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
    queryClient.invalidateQueries({ queryKey: ['trainings'] });
    if (isClassified(scopeValue)) {
      toast.success('Training uploaded. Index it for chat from "All Trainings" once analysis finishes.');
    } else {
      toast.success('Training uploaded. Classify it under "Needs review" to make it searchable.');
    }
    setDone(true);
    setTitle('');
    setVideoUrl('');
    setTranscriptFile(null);
    setScopeValue(SCOPE_UNCLASSIFIED);
    setStatusMsg('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setUploading(false);
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Upload className="w-4 h-4 text-primary" />
          Upload Training Manually
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">Training Title</Label>
          <Input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Q1 Sales Training"
            className="bg-background"
          />
        </div>

        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">
            Transcript File <span className="text-foreground font-medium">(required)</span>
          </Label>
          <div
            className="border-2 border-dashed border-border rounded-xl p-6 text-center cursor-pointer hover:border-primary/50 hover:bg-accent/30 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            {transcriptFile ? (
              <div className="flex items-center justify-center gap-2 text-sm text-foreground">
                <FileText className="w-5 h-5 text-primary" />
                <span className="font-medium">{transcriptFile.name}</span>
              </div>
            ) : (
              <div className="text-muted-foreground">
                <Upload className="w-6 h-6 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Click to upload a .txt, .docx, or .pdf transcript</p>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.doc,.docx,.pdf"
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
            Controls which chat contexts can retrieve this training. Left as "Needs review", it stays out of the chatbot until classified.
          </p>
        </div>

        <Button
          onClick={handleSubmit}
          disabled={uploading || !transcriptFile}
          className="bg-primary hover:bg-primary/90 shadow-md shadow-primary/20 gap-2"
        >
          {uploading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
          ) : done ? (
            <><CheckCircle2 className="w-4 h-4" /> Uploaded!</>
          ) : (
            <><Upload className="w-4 h-4" /> Upload & Process</>
          )}
        </Button>
        {uploading && statusMsg && (
          <p className="text-xs text-muted-foreground">{statusMsg}</p>
        )}
      </CardContent>
    </Card>
  );
}