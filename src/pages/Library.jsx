import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import TrainingCard from '@/components/knowledge/TrainingCard';
import { Input } from '@/components/ui/input';
import { BookOpen, Search, ChevronDown } from 'lucide-react';

const TOPIC_CATEGORIES = ['Bookkeeping', 'Payroll', 'Tax Prep', 'Reconciliation', 'Reporting', 'Cash Flow', 'Entity Management', 'Client Communication', 'Operations', 'Compliance', 'Troubleshooting', 'Other'];
const CLIENT_SEGMENTS = ['Small Business', 'High-Net-Worth Household', 'Both', 'Internal Only'];
const FACING_OPTIONS = ['Internal', 'Client-Facing', 'Both'];
const PRIORITIES = ['High', 'Medium', 'Low'];

function FilterBar({ label, options, value, onChange }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground font-medium">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => onChange('All')}
          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all border ${
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
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all border ${
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
  const [facing, setFacing] = useState('All');
  const [priority, setPriority] = useState('All');
  const [showFilters, setShowFilters] = useState(false);
  const [software, setSoftware] = useState('All');

  const { data: trainings = [], isLoading } = useQuery({
    queryKey: ['trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
  });

  const allSoftware = [...new Set(trainings.flatMap(t => t.software_systems || []))].sort();

  const filtered = trainings.filter(t => {
    const matchesSearch = !search ||
      t.title?.toLowerCase().includes(search.toLowerCase()) ||
      t.summary?.toLowerCase().includes(search.toLowerCase()) ||
      t.presenter?.toLowerCase().includes(search.toLowerCase()) ||
      (t.key_takeaways || []).some(kt => kt.toLowerCase().includes(search.toLowerCase())) ||
      (t.sop_steps || []).some(s => s.toLowerCase().includes(search.toLowerCase()));

    const matchesTopic = topicCategory === 'All' || t.topic_category === topicCategory || t.category === topicCategory;
    const matchesSegment = clientSegment === 'All' || t.client_segment === clientSegment;
    const matchesSoftware = software === 'All' || (t.software_systems || []).includes(software);
    const matchesFacing = facing === 'All' || (t.app_feature_opportunities || []).some(f => f.facing === facing || f.facing === 'Both');
    const matchesPriority = priority === 'All' || (t.app_feature_opportunities || []).some(f => f.priority === priority);

    return matchesSearch && matchesTopic && matchesSegment && matchesSoftware && matchesFacing && matchesPriority;
  });

  const hasActiveFilters = topicCategory !== 'All' || clientSegment !== 'All' || software !== 'All' || facing !== 'All' || priority !== 'All';

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-card border-b border-border px-8 py-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-primary" />
            </div>
            <h1 className="font-sora text-2xl font-bold text-foreground">Training Library</h1>
          </div>
          <p className="text-muted-foreground text-sm ml-11">
            {trainings.length} training{trainings.length !== 1 ? 's' : ''} available
          </p>

          <div className="relative mt-5">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search trainings, SOPs, topics, or takeaways..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-10 bg-background border-border h-11 text-sm"
            />
          </div>

          <button
            onClick={() => setShowFilters(p => !p)}
            className={`mt-4 flex items-center gap-1.5 text-sm font-medium transition-colors ${hasActiveFilters ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
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
            <FilterBar label="Feature Facing" options={FACING_OPTIONS} value={facing} onChange={setFacing} />
            <FilterBar label="Feature Priority" options={PRIORITIES} value={priority} onChange={setPriority} />
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
          <div className="text-center py-20">
            <BookOpen className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground font-medium">No trainings found</p>
            <p className="text-muted-foreground/60 text-sm mt-1">
              {search || hasActiveFilters ? 'Try adjusting your search or filters' : 'Upload a transcript to get started'}
            </p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map(training => (
              <TrainingCard key={training.id} training={training} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}