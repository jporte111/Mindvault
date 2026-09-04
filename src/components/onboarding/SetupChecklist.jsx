import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import { fetchKnowledgeHealth } from '@/lib/knowledgeHealth';
import { deriveChecklistItems, completeCount } from '@/lib/setupChecklist';

const STATE_TONE = {
  Complete: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'In progress': 'bg-amber-100 text-amber-700 border-amber-200',
  'Needs attention': 'bg-red-100 text-red-700 border-red-200',
  'Not started': 'text-muted-foreground border-border',
  Unknown: 'text-muted-foreground border-border',
};

const readLS = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeLS = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

// Onboarding-1 — derived setup checklist. Admin-only. Progressive, never
// blocking: it reports what is configured, it does not gate any feature.
export default function SetupChecklist() {
  const isAdmin = useIsAdmin();
  const { knowledgeHealthEnabled } = useSystemConfig();
  const [collapsed, setCollapsed] = useState(readLS('mv_checklist_collapsed') === 'true');

  const { data: sources = null } = useQuery({
    queryKey: ['all-trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
    enabled: isAdmin,
  });
  const { data: processes = null } = useQuery({
    queryKey: ['operational-processes'],
    queryFn: () => base44.entities.OperationalProcess.list('-created_date'),
    enabled: isAdmin,
  });
  const { data: health = null } = useQuery({
    queryKey: ['knowledge-health', 'general'],
    queryFn: () => fetchKnowledgeHealth('general'),
    enabled: isAdmin && knowledgeHealthEnabled,
  });

  if (!isAdmin) return null;

  const items = deriveChecklistItems({
    healthFlagOn: knowledgeHealthEnabled,
    health: knowledgeHealthEnabled ? health : null,
    sources,
    processes,
    continuityVisited: readLS('mv_continuity_visited') === 'true',
  });
  const done = completeCount(items);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeLS('mv_checklist_collapsed', String(next));
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <button onClick={toggle} className="flex items-center gap-2 w-full text-left">
          {collapsed ? <ChevronRight className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          <ListChecks className="w-4 h-4 text-primary" />
          <CardTitle className="text-base font-semibold flex-1">
            Setup — {done} of {items.length} areas ready
          </CardTitle>
        </button>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground mb-3">
            Firm-wide setup — client-specific setup is reviewed in each client’s Operational Continuity view.
            You don’t need to finish this before using MindVault; work through it as you go.
          </p>
          <ul className="divide-y divide-border">
            {items.map((it) => (
              <li key={it.id} className="py-2.5 flex items-start gap-3">
                <Badge variant="outline" className={`text-[11px] shrink-0 ${STATE_TONE[it.state] || STATE_TONE.Unknown}`}>
                  {it.state}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{it.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{it.detail}</p>
                </div>
                {it.actionHref && (
                  <Link to={it.actionHref} className="text-xs font-medium text-primary hover:underline whitespace-nowrap shrink-0 mt-0.5">
                    {it.actionLabel} →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
