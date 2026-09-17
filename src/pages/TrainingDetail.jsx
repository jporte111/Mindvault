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
import VerifySourceButton from '@/components/training/VerifySourceButton';
import InlineText from '@/components/edit/InlineText';
import ProcessSelect from '@/components/knowledge/ProcessSelect';
import SourceTypeSelect from '@/components/training/SourceTypeSelect';
import ProcessOwnerSelect from '@/components/training/ProcessOwnerSelect';
import { SOURCE_TYPE_OPTIONS } from '@/lib/knowledgeSource';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { saveKnowledgeEdit } from '@/lib/knowledgeLifecycle';

// Fields that feed KnowledgeChunk generation — edits to these go through the
// governed path (updateKnowledgeSource), which forks an unverified draft for a
// published version and never edits served content in place. Non-content
// fields (presenter, video_url…) still save directly.
const CONTENT_FIELDS = new Set([
  'title', 'summary', 'key_takeaways', 'sop_steps', 'decision_rules',
  'common_mistakes', 'required_inputs', 'final_output', 'software_systems',
  'ai_knowledge_entry',
]);
const METADATA_FIELDS = new Set(['operational_process_id']);

export default function TrainingDetail() {
  const { id } = useParams();
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcriptText, setTranscriptText] = useState(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin();

  const handleUpdate = async (field, value) => {
    // Governed content / metadata -> updateKnowledgeSource (may fork a draft).
    if (CONTENT_FIELDS.has(field) || METADATA_FIELDS.has(field)) {
      try {
        const r = await saveKnowledgeEdit(id, { [field]: value });
        if (r?.ok) {
          if (r.mode === 'draft_forked') {
            toast.success('Saved as a new draft revision — review and publish it from Admin → Knowledge Lifecycle.');
          } else {
            toast.success('Saved.');
          }
          queryClient.invalidateQueries({ queryKey: ['training', id] });
          queryClient.invalidateQueries({ queryKey: ['trainings'] });
          queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
        } else if (r?.error === 'lifecycle_disabled') {
          toast.error('Editing knowledge content requires Source Lifecycle (Admin → System).');
          queryClient.invalidateQueries({ queryKey: ['training', id] });
        } else {
          toast.error(r?.message || r?.error || 'Failed to save');
          queryClient.invalidateQueries({ queryKey: ['training', id] });
        }
      } catch (err) {
        toast.error('Failed to save: ' + (err?.message || 'Unknown error'));
        queryClient.invalidateQueries({ queryKey: ['training', id] });
      }
      return;
    }
    // Non-content fields (presenter, etc.) — direct, unchanged.
    try {
      queryClient.setQueryData(['training', id], (old) => ({ ...old, [field]: value }));
      await base44.entities.Training.update(id, { [field]: value });
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
    } catch (err) {
      toast.error('Failed to save: ' + (err?.message || 'Unknown error'));
      queryClient.invalidateQueries({ queryKey: ['training', id] });
    }
  };

  const { data: training, isLoading } = useQuery({
    queryKey: ['training', id],
    queryFn: () => base44.entities.Training.get(id),
  });

  const { data: processes = [] } = useQuery({
    queryKey: ['operational-processes'],
    queryFn: async () => {
      const res = await base44.functions.invoke('listOperationalProcesses');
      return res?.data?.processes ?? res?.processes ?? [];
    },
  });

  const handleReanalyze = async () => {
    setReanalyzing(true);
    toast.info('Analyzing transcript with AI — this may take 30–60 seconds...');

    // Mark as processing, then kick off analysis (don't await — we poll instead)
    await base44.entities.Training.update(id, { status: 'processing' });
    queryClient.invalidateQueries({ queryKey: ['training', id] });
    base44.functions.invoke('analyzeTraining', { trainingId: id }).then((r) => {
      const d = r?.data ?? r;
      // A served governed source can never be re-analyzed in place — flag ON
      // returns 'governed_source', flag OFF returns 'lifecycle_disabled'. Either
      // way, stop the spinner and restore status; the admin must use a draft.
      if (d?.error === 'governed_source' || d?.error === 'lifecycle_disabled') {
        toast.error(d.message || 'This published source needs a draft revision before re-analysis.');
        base44.entities.Training.update(id, { status: 'ready' });
        queryClient.invalidateQueries({ queryKey: ['training', id] });
        setReanalyzing(false);
      }
    }).catch(() => {});

    // Poll every 5s until status leaves "processing"
    const poll = setInterval(async () => {
      const updated = await base44.entities.Training.get(id);
      // Directly update the cache so the UI reflects fresh data immediately
      queryClient.setQueryData(['training', id], updated);
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      if (updated.status !== 'processing') {
        clearInterval(poll);
        setReanalyzing(false);
        if (updated.status === 'ready') {
          toast.success('Analysis complete!');
        } else if (updated.status === 'error') {
          toast.error('Analysis failed. Please try again.');
        }
      }
    }, 5000);
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
          <p className="text-muted-foreground">Knowledge source not found.</p>
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
                {isAdmin ? (
                  <SourceTypeSelect
                    value={training.source_type || ''}
                    onChange={(v) => handleUpdate('source_type', v)}
                  />
                ) : training.source_type ? (
                  <Badge variant="outline" className="text-xs">
                    {SOURCE_TYPE_OPTIONS.find((o) => o.value === training.source_type)?.label || training.source_type}
                  </Badge>
                ) : null}
              </div>
              <h1 className="font-sora text-2xl md:text-3xl font-bold text-foreground leading-tight">
                <InlineText value={training.title} onSave={(v) => handleUpdate('title', v)} isAdmin={isAdmin} className="font-sora text-2xl md:text-3xl font-bold text-foreground leading-tight" />
              </h1>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-muted-foreground">
                {(training.presenter || isAdmin) && (
                  <span className="flex items-center gap-1.5">
                    <User className="w-4 h-4" />
                    <InlineText value={training.presenter} onSave={(v) => handleUpdate('presenter', v)} isAdmin={isAdmin} className="text-sm text-muted-foreground" emptyText="Add presenter" />
                  </span>
                )}
                {training.duration_minutes && (
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-4 h-4" />
                    {training.duration_minutes} minutes
                  </span>
                )}
              </div>
              {(training.operational_process_id || isAdmin) && (
                <div className="flex items-center gap-2 mt-3 text-sm text-muted-foreground">
                  <Workflow className="w-4 h-4 flex-shrink-0" />
                  {isAdmin ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="w-72 max-w-full">
                        <ProcessSelect
                          source={{ knowledge_scope: training.knowledge_scope, client_id: training.client_id }}
                          value={training.operational_process_id || ''}
                          onChange={(v) => handleUpdate('operational_process_id', v || null)}
                          className="h-9"
                        />
                      </div>
                      {training.operational_process_id && processes.find((p) => p.id === training.operational_process_id) && (
                        <ProcessOwnerSelect
                          process={processes.find((p) => p.id === training.operational_process_id)}
                        />
                      )}
                    </div>
                  ) : (
                    <span>
                      {processes.find((p) => p.id === training.operational_process_id)?.name || 'Linked process'}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {training.transcript && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 text-xs border-primary/50 text-primary hover:bg-primary/10"
                  onClick={handleReanalyzeClick}
                  disabled={reanalyzing}
                >
                  {reanalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  {reanalyzing ? 'Analyzing...' : training.summary ? 'Re-analyze with AI' : 'Analyze with AI'}
                </Button>
              )}
              <VerifySourceButton training={training} />
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
        {/* Processing banner */}
        {training.status === 'processing' && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="py-4 flex items-center gap-3">
              <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
              <p className="text-sm text-primary font-medium">AI is analyzing this source — results will appear here shortly. Refresh the page in a minute to see them.</p>
            </CardContent>
          </Card>
        )}

        {/* Summary */}
        {(training.summary || isAdmin) && (
          <Card className="border-border bg-primary/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" />
                Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-foreground text-sm leading-relaxed">
                <InlineText value={training.summary} onSave={(v) => handleUpdate('summary', v)} isAdmin={isAdmin} multiline className="text-foreground text-sm leading-relaxed" emptyText="Click to add a summary" />
              </div>
            </CardContent>
          </Card>
        )}

        {/* All structured sections */}
        <TrainingDetailSections training={training} onUpdate={handleUpdate} />

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