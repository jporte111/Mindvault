import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { User, Clock, ChevronRight, Sparkles, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';

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
  const category = training.topic_category || training.category;
  const colorClass = categoryColors[category] || categoryColors.Other;
  const queryClient = useQueryClient();

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

  return (
    <div className="relative group h-full">
      {/* Delete button — visible on hover */}
      <button
        onClick={handleDelete}
        className={`absolute top-3 right-3 z-10 flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all border
          ${confirmDelete
            ? 'bg-destructive text-white border-destructive opacity-100'
            : 'bg-background/90 text-muted-foreground border-border opacity-0 group-hover:opacity-100 hover:text-destructive hover:border-destructive/50'
          }`}
      >
        <Trash2 className="w-3 h-3" />
        {confirmDelete ? 'Confirm?' : ''}
      </button>

      <Link to={`/training/${training.id}`} className="h-full block">
        <Card className="group/card hover:shadow-xl hover:-translate-y-1 transition-all duration-300 cursor-pointer border border-border bg-card overflow-hidden h-full">
          {/* Top accent bar */}
          <div className="h-1 bg-gradient-to-r from-primary to-primary/40" />

          <CardHeader className="pb-3 pt-5 px-5">
            <div className="flex items-start justify-between gap-3">
              <Badge variant="outline" className={`text-xs font-medium border ${colorClass} shrink-0`}>
                {category || 'Other'}
              </Badge>
              {training.status === 'processing' && (
                <Badge variant="outline" className="text-xs text-muted-foreground border-muted-foreground/30 gap-1">
                  <Sparkles className="w-3 h-3 animate-pulse" />
                  Processing
                </Badge>
              )}
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
    </div>
  );
}