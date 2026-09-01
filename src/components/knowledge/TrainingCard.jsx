import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { User, Clock, ChevronRight, Sparkles, Trash2, Pencil, Check, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import InlineText from '@/components/edit/InlineText';
import EditableList from '@/components/edit/EditableList';
import ClientSelect from '@/components/knowledge/ClientSelect';
import ProcessSelect from '@/components/knowledge/ProcessSelect';
import { classifyTraining, isClassified, resolveScopeFields, scopeValueOf, SCOPE_GENERAL } from '@/lib/knowledgeScope';

const categoryColors = {
  Bookkeeping: 'bg-blue-100 text-blue-700 border-blue-200',
  Payroll: 'bg-green-100 text-green-700 border-green-200',
  'Tax Prep': 'bg-amber-100 text-amber-700 border-amber-200',
  Reconciliation: 'bg-violet-100 text-violet-700 border-violet-200',
  Reporting: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  'Cash Flow': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Entity Management': 'bg-pink-100 text-pink-700 border-pink-200',
  'Client Communication': 'bg-indigo-100 text-indigo-700 border-indigo-200',
  Operations: 'bg-slate-100 text-slate-700 border-slate-200',
  Compliance: 'bg-red-100 text-red-700 border-red-200',
  Troubleshooting: 'bg-orange-100 text-orange-700 border-orange-200',
  Other: 'bg-gray-100 text-gray-700 border-gray-200',
};

export default function TrainingCard({ training }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const category = training.topic_category || training.category;
  const colorClass = categoryColors[category] || categoryColors.Other;
  const scopeVal = scopeValueOf(training);
  const scopeText = scopeVal === SCOPE_GENERAL
    ? 'General'
    : scopeVal.startsWith('client:')
      ? (training.client_name || 'Client-specific')
      : 'Needs review';
  const scopeBadgeClass = isClassified(scopeVal)
    ? 'text-muted-foreground border-border'
    : 'bg-amber-100 text-amber-700 border-amber-200';
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin();
  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: () => base44.entities.Client.list('name'),
    enabled: isAdmin,
  });

  const deleteMutation = useMutation({
    mutationFn: () => base44.entities.Training.delete(training.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
      toast.success('Training deleted');
    },
    onError: (err) => toast.error('Failed to delete: ' + err.message),
  });

  const handleDelete = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirmDelete) {
      deleteMutation.mutate();
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  };

  const startEdit = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDraft({
      title: training.title || '',
      summary: training.summary || '',
      presenter: training.presenter || '',
      key_takeaways: [...(training.key_takeaways || [])],
      scopeValue: scopeValueOf(training),
      operational_process_id: training.operational_process_id || '',
    });
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      const { scopeValue, ...fields } = draft;
      fields.operational_process_id = fields.operational_process_id || null;
      await base44.entities.Training.update(training.id, fields);
      if (scopeValue !== scopeValueOf(training)) {
        await classifyTraining(training.id, scopeValue, clients);
      }
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
      toast.success('Training updated');
      setEditing(false);
      setDraft(null);
    } catch (err) {
      toast.error('Failed to save: ' + (err?.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative group h-full">
      {/* Top-right controls — visible on hover */}
      <div className="absolute top-3 right-3 z-10 flex gap-1.5">
        {isAdmin && !editing && (
          <button
            onClick={startEdit}
            className="flex items-center justify-center gap-1 min-w-[44px] min-h-[44px] px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border bg-background/90 text-muted-foreground border-border md:opacity-0 md:group-hover:opacity-100 hover:text-primary hover:border-primary/50"
            title="Edit"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
        {isAdmin && !editing && (
          <button
            onClick={handleDelete}
            className={`flex items-center justify-center gap-1 min-w-[44px] min-h-[44px] px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border
            ${confirmDelete
                ? 'bg-destructive text-white border-destructive opacity-100'
                : 'bg-background/90 text-muted-foreground border-border md:opacity-0 md:group-hover:opacity-100 hover:text-destructive hover:border-destructive/50'
              }`}
          >
            <Trash2 className="w-3 h-3" />
            {confirmDelete ? 'Confirm?' : ''}
          </button>
        )}
      </div>

      {editing ? (
        <Card className="border border-primary/40 bg-card overflow-hidden h-full ring-2 ring-primary/20">
          <div className="h-1 bg-gradient-to-r from-primary to-primary/40" />
          <CardHeader className="pb-3 pt-5 px-5">
            <Badge variant="outline" className={`text-xs font-medium border ${colorClass} shrink-0 w-fit`}>
              {category || 'Other'}
            </Badge>
            <div className="mt-2">
              <InlineText
                value={draft.title}
                onSave={(v) => setDraft((d) => ({ ...d, title: v }))}
                isAdmin
                className="font-sora font-semibold text-foreground text-base leading-snug w-full"
                emptyText="Training title"
              />
            </div>
            <div className="mt-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Knowledge scope</p>
              <ClientSelect
                value={draft.scopeValue}
                onChange={(v) => setDraft((d) => ({ ...d, scopeValue: v }))}
                disabled={saving}
              />
            </div>
            <div className="mt-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Operational process</p>
              <ProcessSelect
                source={resolveScopeFields(draft.scopeValue, clients)}
                value={draft.operational_process_id}
                onChange={(v) => setDraft((d) => ({ ...d, operational_process_id: v }))}
                disabled={saving}
              />
            </div>
          </CardHeader>

          <CardContent className="px-5 pb-5 space-y-4">
            <InlineText
              value={draft.summary}
              onSave={(v) => setDraft((d) => ({ ...d, summary: v }))}
              isAdmin
              multiline
              className="text-muted-foreground text-sm leading-relaxed w-full"
              emptyText="Click to add a summary"
            />

            <EditableList
              items={draft.key_takeaways}
              onSave={(arr) => setDraft((d) => ({ ...d, key_takeaways: arr }))}
              isAdmin
              listClassName="space-y-1.5"
              textClassName="text-xs text-muted-foreground"
              addLabel="Add takeaway"
              marker={() => <span className="text-primary mt-0.5 flex-shrink-0">•</span>}
            />

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <User className="w-3 h-3" />
              <InlineText
                value={draft.presenter}
                onSave={(v) => setDraft((d) => ({ ...d, presenter: v }))}
                isAdmin
                className="text-xs text-muted-foreground"
                emptyText="Add presenter"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <Button size="sm" className="gap-1.5 text-xs h-11 bg-primary hover:bg-primary/90" onClick={saveEdit} disabled={saving}>
                <Check className="w-3.5 h-3.5" />
                {saving ? 'Saving...' : 'Save'}
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs h-11" onClick={cancelEdit} disabled={saving}>
                <X className="w-3.5 h-3.5" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Link to={`/training/${training.id}`} className="h-full block">
          <Card className="group/card hover:shadow-xl hover:-translate-y-1 transition-all duration-300 cursor-pointer border border-border bg-card overflow-hidden h-full">
            {/* Top accent bar */}
            <div className="h-1 bg-gradient-to-r from-primary to-primary/40" />

            <CardHeader className="pb-3 pt-5 px-5">
              <div className="flex items-start justify-between gap-3">
                <Badge variant="outline" className={`text-xs font-medium border ${colorClass} shrink-0`}>
                  {category || 'Other'}
                </Badge>
                <div className="flex items-center gap-1.5">
                  {isAdmin && (
                    <Badge variant="outline" className={`text-xs border ${scopeBadgeClass}`}>
                      {scopeText}
                    </Badge>
                  )}
                  {training.status === 'processing' && (
                    <Badge variant="outline" className="text-xs text-muted-foreground border-muted-foreground/30 gap-1">
                      <Sparkles className="w-3 h-3 animate-pulse" />
                      Processing
                    </Badge>
                  )}
                </div>
              </div>
              <h3 className="font-sora font-semibold text-foreground text-base leading-snug group-hover/card:text-primary transition-colors mt-2 line-clamp-2">
                {training.title}
              </h3>
            </CardHeader>

            <CardContent className="px-5 pb-5 space-y-4">
              {training.summary && (
                <p className="text-muted-foreground text-sm leading-relaxed line-clamp-3">
                  {training.summary}
                </p>
              )}

              {training.key_takeaways?.length > 0 && (
                <div className="space-y-1.5">
                  {training.key_takeaways.slice(0, 2).map((kt, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <span className="text-primary mt-0.5 flex-shrink-0">•</span>
                      <span className="line-clamp-1">{kt}</span>
                    </div>
                  ))}
                  {training.key_takeaways.length > 2 && (
                    <p className="text-xs text-primary/70 font-medium">+{training.key_takeaways.length - 2} more takeaways</p>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {training.presenter && (
                    <span className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {training.presenter}
                    </span>
                  )}
                  {training.duration_minutes && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {training.duration_minutes}m
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 text-xs font-medium text-primary opacity-0 group-hover/card:opacity-100 transition-opacity">
                  View <ChevronRight className="w-3 h-3" />
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}
    </div>
  );
}