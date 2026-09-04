import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription,
} from '@/components/ui/drawer';
import { CONCEPT_HELP } from '@/lib/conceptHelp';
import { useIsMobile } from '@/hooks/use-mobile';

// Continuity Overview — the "?" help marker on the Currency band card.
// Copy comes from CONCEPT_HELP.currency (single source of onboarding copy);
// the status definitions and the recency-not-correctness caveat render with it.
// Desktop: dark 320px popover. Mobile: bottom sheet with an explicit close
// button at thumb reach. Identical content in both.

const CURRENCY_STATUSES = [
  ['Current', 'no scheduled review is overdue.'],
  ['Slipping', 'at least one review is due soon.'],
  ['Overdue', 'a review date has passed without a check-in.'],
  ['Unknown', 'no source in this scope has a review schedule yet, so there is nothing to measure.'],
];

const CURRENCY_CAVEAT =
  'Currency reflects review recency, not correctness — a source can be “Current” simply because no one has flagged it as outdated yet.';

function HelpContent() {
  const entry = CONCEPT_HELP.currency;
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-white">{entry.term}</p>
      <p className="text-sm leading-relaxed text-slate-200">{entry.text}</p>
      <ul className="space-y-1.5">
        {CURRENCY_STATUSES.map(([label, desc]) => (
          <li key={label} className="text-xs leading-relaxed">
            <span className="font-semibold text-white">{label}</span>
            <span className="text-slate-300"> — {desc}</span>
          </li>
        ))}
      </ul>
      <p className="border-t border-white/10 pt-2 text-xs leading-relaxed text-slate-400">
        {CURRENCY_CAVEAT}
      </p>
    </div>
  );
}

function Pill() {
  return (
    <button
      type="button"
      aria-label="Learn about Currency"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#E2E8F0] text-[10px] font-semibold leading-none text-[#64748B] align-middle transition-colors hover:bg-slate-300 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      ?
    </button>
  );
}

export default function CurrencyHelp() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild><Pill /></DrawerTrigger>
        <DrawerContent className="border-white/10 bg-[#0F172A] text-white">
          <DrawerHeader className="text-left">
            <DrawerTitle className="text-base text-white">Currency</DrawerTitle>
            <DrawerDescription className="sr-only">
              What the Currency band on this dashboard means
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-2">
            <HelpContent />
          </div>
          <div className="mt-auto p-4 pt-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-11 w-full rounded-lg bg-white/10 text-sm font-medium text-white transition-colors hover:bg-white/20"
            >
              Close
            </button>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Pill />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-80 rounded-lg border-0 bg-[#0F172A] p-4 text-white shadow-xl"
      >
        <HelpContent />
      </PopoverContent>
    </Popover>
  );
}