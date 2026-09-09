import { useEffect } from 'react';
import { useTenantBrand } from '@/hooks/useClientSetup';
import { applyTenantBrandTokens, removeTenantBrandTokens } from '@/lib/tenantBrand';

// Renders nothing. For tenant members (anyone with a workspace
// membership), recolors the small accent tokens — primary actions,
// focus rings, active states, progress — with the workspace's saved
// brand color, in both light and dark mode. Super Admins and anyone
// without a membership keep the neutral MindVault palette. Semantic
// colors (destructive, success) are never touched.
export default function TenantBrandTokens() {
  const brand = useTenantBrand();
  const brandColor = brand?.brandColor || '';

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      if (brandColor) applyTenantBrandTokens(brandColor, mq.matches);
      else removeTenantBrandTokens();
    };
    apply();
    mq.addEventListener('change', apply);
    return () => {
      mq.removeEventListener('change', apply);
      removeTenantBrandTokens();
    };
  }, [brandColor]);

  return null;
}