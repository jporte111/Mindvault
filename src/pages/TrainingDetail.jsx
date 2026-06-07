import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Play, User, Clock, FileText, Sparkles } from 'lucide-react';
import TrainingDetailSections from '@/components/training/TrainingDetailSections';

export default function TrainingDetail() {
  const { id } = useParams();
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcriptText, setTranscriptText] = useState(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);

  const { data: training, isLoading } = useQuery({
    queryKey: ['training', id],
    queryFn: () => base44.entities.Training.get(id),
  });

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