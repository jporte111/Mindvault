import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Play, User, Clock, FileText, Sparkles, Loader2 } from 'lucide-react';
import TrainingDetailSections from '@/components/training/TrainingDetailSections';
import CopyAIContext from '@/components/training/CopyAIContext';
import ExportSOPButton from '@/components/training/ExportButtons';
import { toast } from 'sonner';

export default function TrainingDetail() {
  const { id } = useParams();
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcriptText, setTranscriptText] = useState(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const queryClient = useQueryClient();

  const { data: training, isLoading } = useQuery({
    queryKey: ['training', id],
    queryFn: () => base44.entities.Training.get(id),
  });

  const handleReanalyze = async () => {
    setReanalyzing(true);
    toast.info('Analyzing transcript with AI — this may take 30–60 seconds...');

    // Get transcript text — use ExtractDataFromUploadedFile (server-side, no CORS) for URLs
    let transcriptContent = training.transcript;
    if (training.transcript.startsWith('http')) {
      const extracted = await base44.integrations.Core.ExtractDataFromUploadedFile({
        file_url: training.transcript,
        json_schema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The full text content of the transcript' } }
        }
      });
      transcriptContent = extracted?.output?.text || '';
    }

    if (!transcriptContent || transcriptContent.trim().length < 20) {
      toast.error('Could not read transcript content. Try re-uploading the file.');
      setReanalyzing(false);
      return;
    }

    const aiResult = await base44.integrations.Core.InvokeLLM({
      model: 'claude_sonnet_4_6',
      prompt: `You are a financial operations analyst processing a training transcript for a financial concierge firm. Extract structured business logic from the transcript below to power a future AI app.

Transcript:
${transcriptContent.slice(0, 25000)}

Return a JSON object with ALL of the following fields:
- summary: A concise 2-3 sentence summary of what this training covers.
- key_takeaways: Array of 4-7 most important lessons (strings).
- sop_steps: Array of numbered step-by-step operating procedure steps (strings).
- decision_rules: Array of if/then rules extracted from the training (strings).
- common_mistakes: Array of errors, risks, or watchouts to avoid (strings).
- required_inputs: Array of documents, data, software access, or client info needed (strings).
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
          app_feature_opportunities: { type: 'array', items: { type: 'object' } },
          ai_knowledge_entry: { type: 'string' },
          presenter: { type: 'string' },
          duration_minutes: { type: 'number' },
        },
      },
    });

    await base44.entities.Training.update(id, {
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

    queryClient.invalidateQueries({ queryKey: ['training', id] });
    queryClient.invalidateQueries({ queryKey: ['trainings'] });
    toast.success('Analysis complete!');
    setReanalyzing(false);
  };

  const handleReanalyzeClick = async () => {
    console.log('Transcript value:', training.transcript?.slice(0, 200));
    try {
      await handleReanalyze();
    } catch (err) {
      console.error('Re-analyze error:', err);
      toast.error('Something went wrong: ' + (err?.message || 'Unknown error'));
      setReanalyzing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-4xl mx-auto space-y-4">
          <div className="h-6 w-32 bg-muted rounded animate-pulse" />
          <div className="h-10 w-3/4 bg-muted rounded animate-pulse" />
          <div className="h-64 bg-muted rounded-2xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (!training) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">Training not found.</p>
          <Link to="/library" className="text-primary text-sm mt-2 inline-block hover:underline">← Back to Library</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-card border-b border-border px-8 py-6">
        <div className="max-w-4xl mx-auto">
          <Link to="/library" className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm transition-colors mb-4">
            <ArrowLeft className="w-4 h-4" />
            Back to Library
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2 mb-3">
                {training.topic_category && (
                  <Badge variant="secondary" className="text-xs">{training.topic_category}</Badge>
                )}
                {training.client_segment && (
                  <Badge variant="outline" className="text-xs">{training.client_segment}</Badge>
                )}
                {training.status === 'processing' && (
                  <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
                    <Sparkles className="w-3 h-3 animate-pulse" />
                    Processing
                  </Badge>
                )}
              </div>
              <h1 className="font-sora text-2xl md:text-3xl font-bold text-foreground leading-tight">{training.title}</h1>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-muted-foreground">
                {training.presenter && (
                  <span className="flex items-center gap-1.5">
                    <User className="w-4 h-4" />
                    {training.presenter}
                  </span>
                )}
                {training.duration_minutes && (
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-4 h-4" />
                    {training.duration_minutes} minutes
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {training.transcript && !training.summary && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 text-xs border-primary/50 text-primary hover:bg-primary/10"
                  onClick={handleReanalyzeClick}
                  disabled={reanalyzing}
                >
                  {reanalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  {reanalyzing ? 'Analyzing...' : 'Analyze with AI'}
                </Button>
              )}
              <CopyAIContext training={training} />
              <ExportSOPButton training={training} />
              {training.video_url && (
                <a href={training.video_url} target="_blank" rel="noopener noreferrer">
                  <Button className="bg-primary hover:bg-primary/90 shadow-md shadow-primary/25 gap-2">
                    <Play className="w-4 h-4" />
                    Watch Recording
                  </Button>
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="px-8 py-8 max-w-4xl mx-auto space-y-6">
        {/* Summary */}
        {training.summary && (
          <Card className="border-border bg-primary/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" />
                Training Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-foreground text-sm leading-relaxed">{training.summary}</p>
            </CardContent>
          </Card>
        )}

        {/* All structured sections */}
        <TrainingDetailSections training={training} />

        {/* Transcript */}
        {training.transcript && (
          <Card className="border-border">
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" />
                Full Transcript
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                disabled={loadingTranscript}
                onClick={async () => {
                  if (!showTranscript && transcriptText === null) {
                    setLoadingTranscript(true);
                    if (training.transcript.startsWith('http')) {
                      const res = await fetch(training.transcript);
                      setTranscriptText(await res.text());
                    } else {
                      setTranscriptText(training.transcript);
                    }
                    setLoadingTranscript(false);
                  }
                  setShowTranscript(prev => !prev);
                }}
                className="text-xs"
              >
                {loadingTranscript ? 'Loading...' : showTranscript ? 'Hide' : 'Show'} Transcript
              </Button>
            </CardHeader>
            {showTranscript && transcriptText && (
              <CardContent>
                <div className="bg-muted/50 rounded-xl p-4 max-h-96 overflow-y-auto">
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                    {transcriptText}
                  </pre>
                </div>
              </CardContent>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}