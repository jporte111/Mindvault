import { Plus, X } from 'lucide-react';
import InlineText from './InlineText';

export default function EditableList({
  items = [],
  onSave,
  isAdmin,
  ordered = false,
  listClassName = 'space-y-2',
  marker,
  textClassName = 'text-sm text-foreground',
  multiline = true,
  addLabel = 'Add item',
}) {
  const update = (i, v) => onSave(items.map((x, j) => (j === i ? v : x)));
  const remove = (i) => onSave(items.filter((_, j) => j !== i));
  const add = () => onSave([...items, '']);

  const Tag = ordered ? 'ol' : 'ul';

  return (
    <div>
      <Tag className={listClassName}>
        {items.map((item, i) => (
          <li key={i} className="group/el flex items-start gap-2">
            {marker?.(i)}
            <span className="flex-1 min-w-0">
              <InlineText
                value={item}
                onSave={(v) => update(i, v)}
                isAdmin={isAdmin}
                multiline={multiline}
                className={textClassName}
              />
            </span>
            {isAdmin && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  remove(i);
                }}
                className="md:opacity-0 md:group-hover/el:opacity-100 transition-opacity text-muted-foreground hover:text-destructive flex-shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-destructive/10"
                title="Remove"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </li>
        ))}
      </Tag>
      {isAdmin && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            add();
          }}
          className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium mt-2"
        >
          <Plus className="w-3.5 h-3.5" />
          {addLabel}
        </button>
      )}
    </div>
  );
}