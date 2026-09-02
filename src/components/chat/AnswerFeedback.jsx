import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import { FEEDBACK_TYPES } from '@/lib/knowledgeGap';

// Phase 5. Compact feedback row shown under an assistant answer when
// knowledge_gaps_enabled is on. Submitting NEVER edits knowledge — it records a
// KnowledgeFeedback row that an SME reviews.
export default function AnswerFeedback({ message, clientScope, clarificationsEnabled }) {
  const [state, setState] = useState('idle'); // idle | choosing | text | sent
  const [chosenType, setChosenType] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const op = message.operationalAnswer;
  const missingFacets = Array.isArray(op?.missing_facets) ? op.missing_facets : [];
  const sourceIds = (message.sources || []).map((s) => s.id);
  const types = FEEDBACK_TYPES.filter((t) => t.value !== 'still_need_help' || clarificationsEnabled);

  const submit = async (feedbackType, freeText) => {
    setBusy(true);
    try {
      await base44.functions.invoke('submitKnowledgeFeedback', {
        feedbackType,
        answerLogId: message.answerLogId || undefined,
        standaloneQuery: message.standaloneQuery || undefined,
        clientScope: clientScope || 'general',
        operationalProcessId: message.operationalProcessId || undefined,
        relatedSourceIds: sourceIds,
        answerMode: message.answerMode || undefined,
        confidenceLevel: message.answerStatus || undefined,
        reportedMissingFacets: feedbackType === 'missing_detail' ? missingFacets : undefined,
        freeText: freeText || undefined,
      });
      setState('sent');
    } catch {
      setState('sent'); // fail quietly — never block the chat
    } finally {
      setBusy(false);
    }
  };

  if (state === 'sent') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground pl-1 mt-1">
        <Check className="w-3.5 h-3.5 text-green-600" /> Thanks — flagged for review.
      </div>
    );
  }

  return (
    <div className="mt-1.5 pl-1 text-xs">
      {state === 'idle' && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>Was this helpful?</span>
          <button
            disabled={busy}
            onClick={() => submit('helpful')}
            className="p-1 rounded hover:bg-muted"
            aria-label="Helpful"
          >
            <ThumbsUp className="w-3.5 h-3.5" />
          </button>
          <button
            disabled={busy}
            onClick={() => setState('choosing')}
            className="p-1 rounded hover:bg-muted"
            aria-label="Not helpful"
          >
            <ThumbsDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {state === 'choosing' && (
        <div className="flex flex-wrap gap-1.5">
          {types.map((t) => (
            <button
              key={t.value}
              disabled={busy}
              onClick={() => {
                setChosenType(t.value);
                setState('text');
              }}
              className="px-2 py-1 rounded border border-border text-muted-foreground hover:border-primary/50"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {state === 'text' && (
        <div className="space-y-1.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 500))}
            placeholder="What were you looking for? (optional)"
            rows={2}
            className="w-full max-w-md rounded border border-input bg-card px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-muted-foreground/70">
            This goes to a subject-matter expert for review. It won&apos;t change answers directly.
          </p>
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => submit(chosenType, text.trim())}
              className="px-3 py-1 rounded bg-primary text-white font-medium disabled:opacity-50"
            >
              {chosenType === 'still_need_help' ? 'Send to an SME' : 'Submit'}
            </button>
            <button disabled={busy} onClick={() => setState('idle')} className="px-2 py-1 rounded text-muted-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
