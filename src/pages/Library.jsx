import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import TrainingCard from '@/components/knowledge/TrainingCard';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Search, BookOpen, Filter } from 'lucide-react';

export default function Library() {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');

  const { data: trainings = [], isLoading } = useQuery({
    queryKey: ['trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
  });

  const categories = ['All', ...new Set(trainings.map(t => t.category).filter(Boolean))];

  const filtered = trainings.filter(t => {
    const matchesSearch = !search || 
      t.title?.toLowerCase().includes(search.toLowerCase()) ||
      t.summary?.toLowerCase().includes(search.toLowerCase()) ||
      t.presenter?.toLowerCase().includes(search.toLowerCase()) ||
      (t.key_takeaways || []).some(kt => kt.toLowerCase().includes(search.toLowerCase()));
    const matchesCategory = selectedCategory === 'All' || t.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
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

          {/* Search */}
          <div className="relative mt-5">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search trainings, topics, or takeaways..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-10 bg-background border-border h-11 text-sm"
            />
          </div>
        </div>
      </div>

      <div className="px-8 py-6 max-w-5xl mx-auto">
        {/* Category Filter */}
        <div className="flex flex-wrap gap-2 mb-6">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-150 border ${
                selectedCategory === cat
                  ? 'bg-primary text-white border-primary shadow-md shadow-primary/20'
                  : 'bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Grid */}
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
              {search ? 'Try a different search term' : 'Ask an admin to sync trainings from Google Drive'}
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