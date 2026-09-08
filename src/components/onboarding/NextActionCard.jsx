import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowRight } from 'lucide-react';

// The single most important thing to do next, derived from the setup
// checklist — one clear step, one primary action.
export default function NextActionCard({ item }) {
  if (!item) return null;
  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="p-6 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">
          Next recommended step
        </p>
        <div>
          <p className="text-base font-semibold text-foreground">{item.label}</p>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{item.why}</p>
        </div>
        <Button asChild className="bg-primary hover:bg-primary/90 gap-1">
          <Link to={item.actionHref}>
            {item.actionLabel}
            <ArrowRight className="w-4 h-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}