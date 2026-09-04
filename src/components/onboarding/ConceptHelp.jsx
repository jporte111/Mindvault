import { CircleHelp } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CONCEPT_HELP } from '@/lib/conceptHelp';

// Onboarding-2 — a small inline "?" that reveals one Onboarding-1 CONCEPT_HELP
// definition next to a label, header, or card. It never duplicates copy: the
// term and text always come straight from CONCEPT_HELP[term]. An unknown
// term renders nothing — it must never throw or block the screen it sits on.
export default function ConceptHelp({ term, className = '' }) {
  const entry = CONCEPT_HELP[term];
  if (!entry) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Learn about ${entry.term}`}
          className={`inline-flex items-center justify-center w-4 h-4 shrink-0 rounded-full text-muted-foreground/60 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring align-middle ${className}`}
        >
          <CircleHelp className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3 text-xs">
        <p className="font-medium text-foreground mb-1">{entry.term}</p>
        <p className="text-muted-foreground leading-relaxed">{entry.text}</p>
      </PopoverContent>
    </Popover>
  );
}
