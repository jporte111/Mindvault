import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Circle, CircleDashed, ArrowRight } from 'lucide-react';
import { clientSetupCompleteCount } from '@/lib/clientSetup';

const STATE_ICON = {
  Complete: CheckCircle2,
  'In progress': Circle,
  'Not started': Circle,
  Unknown: CircleDashed,
};

// Getting Started checklist for Client Admins — live progress derived from
// the tenant's own data (see src/lib/clientSetup.js). Never blocking; each
// incomplete item links to the page where that step happens.
export default function ClientSetupChecklist({ items }) {
  const done = clientSetupCompleteCount(items);

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">Set up your MindVault</CardTitle>
        <p className="text-xs text-muted-foreground">
          {done} of {items.length} complete — work at your own pace, progress updates automatically.
        </p>
      </CardHeader>
      <CardContent className="pt-2">
        <div className="divide-y divide-border">
          {items.map((item) => {
            const Icon = STATE_ICON[item.state] || Circle;
            const complete = item.state === 'Complete';
            return (
              <div key={item.id} className="flex items-start gap-3 py-4">
                <Icon
                  className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                    complete ? 'text-emerald-500' : 'text-muted-foreground/40'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{item.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{item.detail}</p>
                </div>
                {!complete && (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="h-9 text-xs gap-1 flex-shrink-0"
                  >
                    <Link to={item.actionHref}>
                      {item.actionLabel}
                      <ArrowRight className="w-3 h-3" />
                    </Link>
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}