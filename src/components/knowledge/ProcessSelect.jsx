import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { isProcessScopeCompatible } from '@/lib/operationalProcess';

// Reusable picker for linking a knowledge source to an OperationalProcess.
// Value is a process id, or '' for "not linked".
//
// `source` is { knowledge_scope, client_id } of the thing being linked. Only
// scope-compatible processes are selectable. A currently-linked process that is
// archived or scope-incompatible is kept visible but flagged, never silently
// dropped.
export default function ProcessSelect({
  source,
  value = '',
  onChange,
  disabled = false,
  allowNone = true,
  noneLabel = 'No operational process',
  className = '',
}) {
  const { data: processes = [] } = useQuery({
    queryKey: ['operational-processes'],
    queryFn: async () => {
      const res = await base44.functions.invoke('listOperationalProcesses');
      return res?.data?.processes ?? res?.processes ?? [];
    },
  });

  const selectable = processes.filter(
    (p) => p.status !== 'archived' && (!source || isProcessScopeCompatible(source, p)),
  );

  // Keep the current value visible even if it's no longer selectable.
  let currentFlag = null;
  if (value && !selectable.some((p) => p.id === value)) {
    const linked = processes.find((p) => p.id === value);
    if (!linked) {
      currentFlag = { id: value, label: 'Linked process (not found)' };
    } else if (linked.status === 'archived') {
      currentFlag = { id: linked.id, label: `${linked.name} (archived)` };
    } else {
      currentFlag = { id: linked.id, label: `${linked.name} (scope mismatch — unlink to change)` };
    }
  }

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      className={`h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${className}`}
    >
      {allowNone && <option value="">{noneLabel}</option>}
      {selectable.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}{p.department ? ` — ${p.department}` : ''}
        </option>
      ))}
      {currentFlag && (
        <option value={currentFlag.id}>{currentFlag.label}</option>
      )}
    </select>
  );
}
