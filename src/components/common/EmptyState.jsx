import { Link } from 'react-router-dom';

// Onboarding-1 — one reusable empty state. Every use should answer: what this
// area is for, why it matters, and the next action. `action` is optional; omit
// it (or pass a null href) for states where there is no single next step, or
// where the only action is admin-only and the viewer is an employee.
export default function EmptyState({ icon: Icon = null, title, body = '', action = null, className = '' }) {
  return (
    <div className={`text-center py-12 px-6 ${className}`}>
      {Icon && <Icon className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" aria-hidden />}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {body && (
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto leading-relaxed">{body}</p>
      )}
      {action?.href && (
        <Link
          to={action.href}
          className="inline-flex items-center gap-1 mt-3 text-xs font-medium text-primary hover:underline"
        >
          {action.label} →
        </Link>
      )}
    </div>
  );
}
