import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { CLIENT_PREFIX, SCOPE_GENERAL, SCOPE_UNCLASSIFIED } from '@/lib/knowledgeScope';

// Scope picker for a training / recording. Value is one of:
//   "unclassified" | "general" | "client:<id>"
export default function ClientSelect({
  value = SCOPE_UNCLASSIFIED,
  onChange,
  includeNeedsReview = true,
  disabled = false,
  className = '',
}) {
  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: () => base44.entities.Client.list('name'),
  });

  const active = clients.filter((c) => c.status !== 'archived');

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      className={`h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${className}`}
    >
      {includeNeedsReview && <option value={SCOPE_UNCLASSIFIED}>Needs review (not searchable)</option>}
      <option value={SCOPE_GENERAL}>Firm-wide / general knowledge</option>
      {active.length > 0 && (
        <optgroup label="Client-specific">
          {active.map((c) => (
            <option key={c.id} value={CLIENT_PREFIX + c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
