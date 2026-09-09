import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Circle, CircleDashed, ArrowRight, Loader2 } from 'lucide-react';
import { clientSetupCompleteCount, clientSetupProgressPct } from '@/lib/clientSetup';

const STATE_ICON = {
  Complete: CheckCircle2,
  'In progress': Circle,
  'Not started': Circle,
  Unknown: CircleDashed,
};

// The guided setup checklist for Client Admins — live progress derived from
// the tenant's own data (see src/lib/clientSetup.js). Each step explains
// what it is, why it matters, what to do, and what "complete" means, with a
// direct action button. Manual steps can be marked done by the user.
export default function ClientSetupChecklist({ items, onMarkDone }) {
  const [busyId, setBusyId] = useState(null);
  const done = clientSetupCompleteCount(items);
  const pct = clientSetupProgressPct(items);

  const handleMarkDone = async (id) => {
    setBusyId(id);
    await onMarkDone?.(id);
    setBusyId(null);
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base font-semibold">Setup checklist</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {done} of {items.length} steps complete
            </p>
          </div>
          <span className="text-sm font-semibold text-primary">{pct}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden mt-3">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Completed steps disappear — the list always shows what's left. */}
        {items.every((item) => item.state === 'Complete') ? (
          <p className="py-5 text-sm text-muted-foreground">
            All steps are complete — nice work.
          </p>
        ) : (
        <div className="divide-y divide-border">
          {items.filter((item) => item.state !== 'Complete').map((item) => {
            const Icon = STATE_ICON[item.state] || Circle;
            const complete = item.state === 'Complete';
            return (
              <div key={item.id} className="py-5">
                <div className="flex items-start gap-3">
                  <Icon
                    className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                      complete ? 'text-emerald-500' : 'text-muted-foreground/40'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-foreground">{item.label}</p>
                      <Badge
                        variant={item.required ? 'default' : 'secondary'}
                        className="text-[10px] px-2 py-0"
                      >
                        {item.required ? 'Required' : 'Optional'}
                      </Badge>
                    </div>
                    <p
                      className={`text-xs mt-1 ${complete ? 'text-emerald-600' : 'text-muted-foreground'}`}
                    >
                      {item.detail}
                    </p>
                    <div className="mt-2 space-y-1">
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <span className="font-medium text-foreground/70">Why it matters: </span>
                        {item.why}
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <span className="font-medium text-foreground/70">What to do: </span>
                        {item.how}
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <span className="font-medium text-foreground/70">You're done when: </span>
                        {item.doneWhen}
                      </p>
                    </div>
                  </div>
                </div>
                {!complete && (
                  <div className="mt-3 pl-8 flex flex-wrap items-center gap-2">
                    <Button
                      asChild
                      size="sm"
                      className="h-9 text-xs bg-primary hover:bg-primary/90 gap-1"
                    >
                      <Link to={item.actionHref}>
                        {item.actionLabel}
                        <ArrowRight className="w-3 h-3" />
                      </Link>
                    </Button>
                    {item.markDoneLabel && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 text-xs"
                        disabled={busyId === item.id}
                        onClick={() => handleMarkDone(item.id)}
                      >
                        {busyId === item.id && <Loader2 className="w-3 h-3 animate-spin" />}
                        {item.markDoneLabel}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        )}
      </CardContent>
    </Card>
  );
}