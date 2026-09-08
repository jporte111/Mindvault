import { useEffect } from 'react';

/**
 * Deep-link support: when the page is opened with a #section-id hash
 * (e.g. /manage#manage-knowledge from a setup-checklist action), scroll the
 * referenced section into view shortly after mount. The short delay lets the
 * page's content render first.
 */
export function useHashScroll(delayMs = 150) {
  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;
    const t = setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);
}