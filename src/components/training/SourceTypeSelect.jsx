import { SOURCE_TYPE_OPTIONS } from '@/lib/knowledgeSource';

// Quick picker for a knowledge source's type (SOP document, process document,
// policy, …). Same vocabulary as the Add Knowledge picker. Pure UI — the save
// is handled by the parent via onChange.
export default function SourceTypeSelect({ value = '', onChange, className = '' }) {
  return (
    <select
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v) onChange?.(v);
      }}
      aria-label="Knowledge type"
      className={`h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {!value && <option value="">Type not set</option>}
      {SOURCE_TYPE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}