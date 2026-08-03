import { useState, useRef, useEffect } from 'react';
import { Pencil } from 'lucide-react';

export default function InlineText({
  value,
  onSave,
  isAdmin,
  multiline = false,
  className = '',
  emptyText = 'Click to edit',
  placeholder = 'Type here...',
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const ref = useRef(null);

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      const el = ref.current;
      const len = (el.value || '').length;
      try {
        el.setSelectionRange(len, len);
      } catch {}
    }
  }, [editing]);

  if (!isAdmin) {
    return <span className={className}>{value}</span>;
  }

  const save = () => {
    setEditing(false);
    if ((draft ?? '') !== (value ?? '')) onSave?.(draft);
  };

  const cancel = () => {
    setDraft(value ?? '');
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter' && !multiline) {
      e.preventDefault();
      save();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && multiline) {
      e.preventDefault();
      save();
    }
  };

  if (editing) {
    const inputClass = `w-full bg-background border border-primary/50 rounded-md px-2 py-1 outline-none ring-2 ring-primary/20 ${className}`;
    return multiline ? (
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        className={`${inputClass} resize-y min-h-[80px]`}
        placeholder={placeholder}
      />
    ) : (
      <input
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        className={inputClass}
        placeholder={placeholder}
      />
    );
  }

  return (
    <span
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setEditing(true);
      }}
      className={`${className} group/edit relative cursor-text rounded px-1 -mx-1 transition-colors hover:bg-primary/5 hover:ring-1 hover:ring-primary/30`}
      title="Click to edit"
    >
      {value ? (
        value
      ) : (
        <span className="text-muted-foreground/50 italic">{emptyText}</span>
      )}
      <Pencil className="inline-block w-3 h-3 ml-1 text-primary/50 md:opacity-0 md:group-hover/edit:opacity-100 transition-opacity align-text-bottom" />
    </span>
  );
}