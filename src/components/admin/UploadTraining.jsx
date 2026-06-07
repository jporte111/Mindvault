import { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Upload, FileText, Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

export default function UploadTraining() {
  const [title, setTitle] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [transcriptFile, setTranscriptFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [done, setDone] = useState(false);
  const fileInputRef = useRef();
  const queryClient = useQueryClient();

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

    // 4. AI processing — full structured business logic extraction
    setStatusMsg('AI is analyzing the transcript (this may take 30-60 seconds)...');
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
- final_output: A string describing what this workflow produces (e.g. "Reconciled bank statement, journal entries, and monthly close report").
- client_segment: One of: "Small Business", "High-Net-Worth Household", "Both", "Internal Only".
- topic_category: One of: "Bookkeeping", "Payroll", "Tax Prep", "Reconciliation", "Reporting", "Cash Flow", "Entity Management", "Client Communication", "Operations", "Compliance", "Troubleshooting", "Other".
- software_systems: Array of software tools, portals, or systems mentioned (strings, e.g. "QuickBooks Online", "Excel", "ADP").
- app_feature_opportunities: Array of objects, each with:
    - feature_name: Short name for the feature
    - problem_solved: What problem this feature solves
    - user_type: Who uses it (e.g. "Bookkeeper", "Small Business Owner", "HNW Client", "CFO", "Internal Employee")
    - required_inputs: What data the feature needs
    - output: What the feature produces
    - facing: One of "Internal", "Client-Facing", "Both"
    - priority: One of "High", "Medium", "Low"
- ai_knowledge_entry: A clean, well-written knowledge base entry (2-4 paragraphs) that an AI assistant can use to answer questions about this topic accurately.
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

    // 5. Save to DB
    setStatusMsg('Saving to knowledge base...');
    await base44.entities.Training.create({
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

    queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
    queryClient.invalidateQueries({ queryKey: ['trainings'] });
    toast.success('Training uploaded and fully processed!');
    setDone(true);
    setTitle('');
    setVideoUrl('');
    setTranscriptFile(null);
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