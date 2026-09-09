import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Deep-link support: when the page is opened with a #section-id hash
 * (e.g. /manage#manage-knowledge from a setup-checklist action), scroll the
 * referenced section into view shortly after it is applied. The short delay
 * lets the page's content render first. Keyed on the router location's hash
 * and key, so it also fires when the hash changes (or the same hash link is
 * followed again) while the page is already mounted, not only on first mount.
 */
export function useHashScroll(delayMs = 150) {
  const { hash, key } = useLocation();
  useEffect(() => {
    const id = hash.replace('#', '');
    if (!id) return;
    const t = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, delayMs);
    return () => clearTimeout(t);
  }, [hash, key, delayMs]);
}