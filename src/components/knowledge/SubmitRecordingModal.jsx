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
import { isClassified, resolveScopeFields, reindexTraining, SCOPE_UNCLASSIFIED } from '@/lib/knowledgeScope';

export default function SubmitRecordingModal({ open, onClose }) {
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

  const handleClose = () => {
    if (uploading) return;
    setTitle(''); setVideoUrl(''); setTranscriptFile(null);
    setStatusMsg(''); setDone(false); setScopeValue(SCOPE_UNCLASSIFIED);
    if (fileInputRef.current) fileInputRef.current.value = '';
    onClose();
  };

  const handleSubmit = async () => {
    if (!transcriptFile) { toast.error('Please select a transcript file'); return; }
    if (!title.trim()) { toast.error('Please enter a title'); return; }

    setUploading(true);
    setDone(false);

    setStatusMsg('Uploading file...');
    const { file_url } = await base44.integrations.Core.UploadFile({ file: transcriptFile });

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
      setUploading(false); setStatusMsg('');
      return;
    }

    setStatusMsg('Saving transcript...');
    const textFile = new File([transcript], 'transcript.txt', { type: 'text/plain' });
    const { file_url: transcriptFileUrl } = await base44.integrations.Core.UploadFile({ file: textFile });

    setStatusMsg('AI is analyzing the transcript (this may take 30–60 seconds)...');
    const aiResult = await base44.integrations.Core.InvokeLLM({
      model: 'claude_sonnet_4_6',
      prompt: `You are a financial operations analyst processing a training transcript for a financial concierge firm. Extract structured business logic from the transcript below to power a future AI app.

Transcript:
${transcript.slice(0, 20000)}

Return a JSON object with ALL of the following fields:

- summary: A concise 2-3 sentence summary of what this training covers.
- key_takeaways: Array of 4-7 most important lessons (strings).
- sop_steps: Array of numbered step-by-step operating procedure steps (strings, e.g. "1. Log into QuickBooks and navigate to...").
- decision_rules: Array of if/then rules extracted from the training (strings, e.g. "If a client has multiple entities, then...").
- common_mistakes: Array of errors, risks, misclassifications, or watchouts to avoid (strings).
- required_inputs: Array of documents, data, software access, or client info needed to complete this workflow (strings).
- final_output: A string describing what this workflow produces.
- client_segment: One of: "Small Business", "High-Net-Worth Household", "Both", "Internal Only".
- topic_category: One of: "Bookkeeping", "Payroll", "Tax Prep", "Reconciliation", "Reporting", "Cash Flow", "Entity Management", "Client Communication", "Operations", "Compliance", "Troubleshooting", "Other".
- software_systems: Array of software tools or systems mentioned (strings).
- app_feature_opportunities: Array of objects with: feature_name, problem_solved, user_type, required_inputs, output, facing (one of "Internal","Client-Facing","Both"), priority (one of "High","Medium","Low").
- ai_knowledge_entry: A clean knowledge base entry (2-4 paragraphs) for an AI assistant.
- presenter: The presenter's name if identifiable, otherwise null.
- duration_minutes: Estimated duration in minutes as a number.`,
      response_json_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          key_takeaways: { type: 'array', items: { type: 'string' } },
          sop_steps: { type: 'array', items: { type: 'string' } },
          decision_rules: { type: 'array', items: { type: 'string' } },
          common_mistakes: { type: 'array', items: { type: 'string' } },
          required_inputs: { type: 'array', items: { type: 'string' } },
          final_output: { type: 'string' },
          client_segment: { type: 'string' },
          topic_category: { type: 'string' },
          software_systems: { type: 'array', items: { type: 'string' } },
          app_feature_opportunities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                feature_name: { type: 'string' },
                problem_solved: { type: 'string' },
                user_type: { type: 'string' },
                required_inputs: { type: 'string' },
                output: { type: 'string' },
                facing: { type: 'string' },
                priority: { type: 'string' }
              }
            }
          },
          ai_knowledge_entry: { type: 'string' },
          presenter: { type: 'string' },
          duration_minutes: { type: 'number' },
        },
      },
    });

    setStatusMsg('Saving to knowledge base...');
    const created = await base44.entities.Training.create({
      ...resolveScopeFields(scopeValue, clients),
      title: title.trim(),
      transcript: transcriptFileUrl,
      video_url: videoUrl.trim() || undefined,
      summary: aiResult.summary,
      key_takeaways: aiResult.key_takeaways,
      sop_steps: aiResult.sop_steps,
      decision_rules: aiResult.decision_rules,
      common_mistakes: aiResult.common_mistakes,
      required_inputs: aiResult.required_inputs,
      final_output: aiResult.final_output,
      client_segment: aiResult.client_segment,
      topic_category: aiResult.topic_category,
      category: aiResult.topic_category,
      software_systems: aiResult.software_systems,
      app_feature_opportunities: aiResult.app_feature_opportunities,
      ai_knowledge_entry: aiResult.ai_knowledge_entry,
      presenter: aiResult.presenter || undefined,
      duration_minutes: aiResult.duration_minutes,
      status: 'ready',
    });

    if (isClassified(scopeValue)) {
      setStatusMsg('Indexing for chat...');
      await reindexTraining(created.id);
    }

    queryClient.invalidateQueries({ queryKey: ['trainings'] });
    queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
    toast.success(
      isClassified(scopeValue)
        ? 'Recording submitted, processed, and indexed for chat!'
        : 'Recording submitted. Classify it under "Needs review" to make it searchable.',
    );
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
            Submit a Recording
          </DialogTitle>
        </DialogHeader>

        {done ? (
          <div className="py-8 text-center space-y-3">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto" />
            <p className="font-semibold text-foreground">Successfully submitted!</p>
            <p className="text-sm text-muted-foreground">Your recording has been processed and added to the library.</p>
            <Button onClick={handleClose} className="mt-2">Close</Button>
          </div>
        ) : (
          <div className="space-y-4 pt-2">
            <div>
              <Label className="text-sm text-muted-foreground mb-1.5 block">Training Title</Label>
              <Input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Q1 Bookkeeping Walkthrough"
                className="bg-background"
                disabled={uploading}
              />
            </div>

            <div>
              <Label className="text-sm text-muted-foreground mb-1.5 block">
                Transcript File <span className="text-foreground font-medium">(required)</span>
              </Label>
              <div
                className="border-2 border-dashed border-border rounded-xl p-5 text-center cursor-pointer hover:border-primary/50 hover:bg-accent/30 transition-colors"
                onClick={() => !uploading && fileInputRef.current?.click()}
              >
                {transcriptFile ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-foreground">
                    <FileText className="w-5 h-5 text-primary" />
                    <span className="font-medium">{transcriptFile.name}</span>
                    {!uploading && (
                      <button onClick={e => { e.stopPropagation(); setTranscriptFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}>
                        <X className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="text-muted-foreground">
                    <Upload className="w-6 h-6 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Click to upload a .txt, .docx, or .pdf transcript</p>
                  </div>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept=".txt,.doc,.docx,.pdf" className="hidden" onChange={handleFileChange} />
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
                "Needs review" keeps this recording out of the chatbot until an admin classifies it.
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
                disabled={uploading || !transcriptFile}
                className="flex-1 bg-primary hover:bg-primary/90 gap-2"
              >
                {uploading ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</> : <><Upload className="w-4 h-4" /> Submit</>}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}