import { cn } from '@/lib/utils';

// A small, compact tenant logo mark — the saved company logo when one
// exists, otherwise a rounded initial chip in the saved brand color.
// Sized by className; keep it small (16-32px) — this is subtle tenant
// identity, never a banner.
export default function TenantLogoMark({ name, logoUrl, brandColor, className }) {
  const label = (name || '').trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex items-center justify-center flex-shrink-0 rounded-md overflow-hidden bg-muted',
        className || 'w-6 h-6'
      )}
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" className="w-full h-full object-contain" />
      ) : (
        <span
          className="w-full h-full flex items-center justify-center text-[11px] font-semibold text-white"
          style={brandColor ? { background: brandColor } : undefined}
        >
          {label}
        </span>
      )}
    </span>
  );
}