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
    const { file_url } = await base44.integrations.Core.UploadFile({ file: transcriptFile });

    // 2. Extract text content
    let transcript = '';
    const fileName = transcriptFile.name.toLowerCase();
    if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
      // Use LLM vision to extract text from Word docs
      const extracted = await base44.integrations.Core.InvokeLLM({
        prompt: 'Extract the full verbatim text content from this document. Return only the raw text, no commentary.',
        file_urls: [file_url]
      });
      transcript = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
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
      return;
    }

    // 3. AI processing
    const aiResult = await base44.integrations.Core.InvokeLLM({
      prompt: `You are processing a training session transcript. Extract and generate the following from the transcript below.

Transcript:
${transcript.slice(0, 15000)}

Return a JSON object with:
- summary: A professional 2-3 sentence summary
- key_takeaways: Array of 3-5 key takeaways (strings)
- category: One category that fits best (e.g. "Sales", "Product", "Engineering", "HR", "Operations", "Marketing", "Other")
- presenter: The presenter's name if identifiable, otherwise null
- duration_minutes: Estimated duration in minutes based on transcript length (rough estimate), as a number`,
      response_json_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          key_takeaways: { type: 'array', items: { type: 'string' } },
          category: { type: 'string' },
          presenter: { type: 'string' },
          duration_minutes: { type: 'number' },
        },
      },
    });

    // 4. Save to DB — store file_url instead of raw transcript text
    await base44.entities.Training.create({
      title: title.trim(),
      transcript: file_url,
      video_url: videoUrl.trim() || undefined,
      summary: aiResult.summary,
      key_takeaways: aiResult.key_takeaways,
      category: aiResult.category,
      presenter: aiResult.presenter || undefined,
      duration_minutes: aiResult.duration_minutes,
      status: 'ready',
    });

    queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
    queryClient.invalidateQueries({ queryKey: ['trainings'] });
    toast.success('Training uploaded and processed!');
    setDone(true);
    setTitle('');
    setVideoUrl('');
    setTranscriptFile(null);
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
                <p className="text-sm">Click to upload a .txt or .docx transcript</p>
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
        {uploading && (
          <p className="text-xs text-muted-foreground">AI is processing the transcript — this may take 15-30 seconds…</p>
        )}
      </CardContent>
    </Card>
  );
}