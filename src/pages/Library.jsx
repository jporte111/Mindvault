import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import TrainingCard from '@/components/knowledge/TrainingCard';
import EmptyState from '@/components/common/EmptyState';
import { Input } from '@/components/ui/input';
import { BookOpen, Search, ChevronDown, Download, Upload } from 'lucide-react';
import SubmitRecordingModal from '@/components/knowledge/SubmitRecordingModal';
import { Button } from '@/components/ui/button';
import PullToRefresh from '@/components/layout/PullToRefresh';

const TOPIC_CATEGORIES = ['Bookkeeping', 'Payroll', 'Tax Prep', 'Reconciliation', 'Reporting', 'Cash Flow', 'Entity Management', 'Client Communication', 'Operations', 'Compliance', 'Troubleshooting', 'Other'];
const CLIENT_SEGMENTS = ['Small Business', 'High-Net-Worth Household', 'Both', 'Internal Only'];

function FilterBar({ label, options, value, onChange }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground font-medium">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => onChange('All')}
          className={`px-3.5 py-1.5 min-h-[44px] inline-flex items-center rounded-full text-xs font-medium transition-all border ${
            value === 'All'
              ? 'bg-primary text-white border-primary'
              : 'bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground'
          }`}
        >
          All
        </button>
        {options.map(opt => (
          <button
            key={opt}
            onClick={() => onChange(opt === value ? 'All' : opt)}
            className={`px-3.5 py-1.5 min-h-[44px] inline-flex items-center rounded-full text-xs font-medium transition-all border ${
              value === opt
                ? 'bg-primary text-white border-primary'
                : 'bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Library() {
  const [search, setSearch] = useState('');
  const [topicCategory, setTopicCategory] = useState('All');
  const [clientSegment, setClientSegment] = useState('All');
  const [showFilters, setShowFilters] = useState(false);
  const [software, setSoftware] = useState('All');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const queryClient = useQueryClient();

  const { data: trainings = [], isLoading } = useQuery({
    queryKey: ['trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
  });

  const allSoftware = [...new Set(trainings.flatMap(t => t.software_systems || []))].sort();

  const filtered = trainings.filter(t => {
    const q = search.toLowerCase();
    const matchesSearch = !search ||
      t.title?.toLowerCase().includes(q) ||
      t.summary?.toLowerCase().includes(q) ||
      t.presenter?.toLowerCase().includes(q) ||
      t.final_output?.toLowerCase().includes(q) ||
      (t.key_takeaways || []).some(kt => kt.toLowerCase().includes(q)) ||
      (t.sop_steps || []).some(s => s.toLowerCase().includes(q)) ||
      (t.decision_rules || []).some(r => r.toLowerCase().includes(q)) ||
      (t.common_mistakes || []).some(m => m.toLowerCase().includes(q)) ||
      (t.required_inputs || []).some(i => i.toLowerCase().includes(q)) ||
      (t.software_systems || []).some(s => s.toLowerCase().includes(q)) ||
      (t.app_feature_opportunities || []).some(f =>
        f.feature_name?.toLowerCase().includes(q) ||
        f.problem_solved?.toLowerCase().includes(q) ||
        f.output?.toLowerCase().includes(q)
      );

    const matchesTopic = topicCategory === 'All' || t.topic_category === topicCategory || t.category === topicCategory;
    const matchesSegment = clientSegment === 'All' || t.client_segment === clientSegment;
    const matchesSoftware = software === 'All' || (t.software_systems || []).includes(software);

    return matchesSearch && matchesTopic && matchesSegment && matchesSoftware;
  });

  const hasActiveFilters = topicCategory !== 'All' || clientSegment !== 'All' || software !== 'All';

  return (
    <div className="min-h-screen bg-background">
      <SubmitRecordingModal open={showUploadModal} onClose={() => setShowUploadModal(false)} />
      <PullToRefresh onRefresh={() => queryClient.invalidateQueries({ queryKey: ['trainings'] })}>
        <div className="bg-card border-b border-border px-8 py-8" data-tour="library-page">
          <div className="max-w-5xl mx-auto">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <BookOpen className="w-4 h-4 text-primary" />
              </div>
              <h1 className="font-sora text-2xl font-bold text-foreground">Knowledge Library</h1>
            </div>
            <div className="flex items-center justify-between ml-11">
              <p className="text-muted-foreground text-sm">
                {trainings.length} knowledge source{trainings.length !== 1 ? 's' : ''}
              </p>
              <div className="flex gap-2">
                <Button data-tour="add-knowledge" size="sm" className="gap-2 text-xs bg-primary hover:bg-primary/90" onClick={() => setShowUploadModal(true)}>
                  <Upload className="w-3.5 h-3.5" />
                  Add Knowledge
                </Button>
                <Button variant="outline" size="sm" className="gap-2 text-xs" onClick={() => {
                  const headers = ['Title', 'Topic Category', 'Client Segment', 'Presenter', 'Duration (min)', 'Software Systems', 'Final Output'];
                  const rows = trainings.map(t => [
                    t.title, t.topic_category, t.client_segment, t.presenter, t.duration_minutes,
                    (t.software_systems || []).join('; '), t.final_output
                  ].map(v => `"${(v || '').toString().replace(/"/g, '""')}"`));
                  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a'); a.href = url; a.download = 'all-decision-rules.csv'; a.click();
                  URL.revokeObjectURL(url);
                }}>
                  <Download className="w-3.5 h-3.5" />
                  Export Decision Rules CSV
                </Button>
              </div>
            </div>

            <div className="relative mt-5">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                data-tour="knowledge-search"
                placeholder="Search knowledge, SOPs, topics, or takeaways..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-10 bg-background border-border h-11 text-sm"
              />
            </div>

            <button
              data-tour="knowledge-filters"
              onClick={() => setShowFilters(p => !p)}
              className={`mt-3 flex items-center gap-1.5 min-h-[44px] text-sm font-medium transition-colors ${hasActiveFilters ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
              {hasActiveFilters ? 'Filters active' : 'Show filters'}
            </button>
          </div>
        </div>

        {showFilters && (
          <div className="border-b border-border bg-card/50 px-8 py-5">
            <div className="max-w-5xl mx-auto space-y-4">
              <FilterBar label="Topic Category" options={TOPIC_CATEGORIES} value={topicCategory} onChange={setTopicCategory} />
              <FilterBar label="Client Segment" options={CLIENT_SEGMENTS} value={clientSegment} onChange={setClientSegment} />
              {allSoftware.length > 0 && (
                <FilterBar label="Software / System" options={allSoftware} value={software} onChange={setSoftware} />
              )}
            </div>
          </div>
        )}

        <div className="px-8 py-6 max-w-5xl mx-auto">
          {isLoading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="h-64 rounded-2xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            (search || hasActiveFilters) ? (
              <div className="text-center py-20">
                <BookOpen className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                <p className="text-muted-foreground font-medium">No matching knowledge</p>
                <p className="text-muted-foreground/60 text-sm mt-1">Try adjusting your search or filters.</p>
              </div>
            ) : (
              <div data-tour="knowledge-empty-state">
                <EmptyState
                  icon={BookOpen}
                  title="No knowledge yet"
                  body="This is your team's knowledge library — SOPs, process docs, policies and recordings that the AI Assistant answers from. Add your first source with “Add Knowledge” above, or connect Google Drive to import."
                />
              </div>
            )
          ) : (
            <div data-tour="knowledge-results" className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filtered.map(training => (
                <TrainingCard key={training.id} training={training} />
              ))}
            </div>
          )}
        </div>
      </PullToRefresh>
    </div>
  );
}