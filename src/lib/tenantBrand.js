// Tenant brand helpers — the single reusable accessor for a client
// company's saved identity (name, logo, brand color), plus the small
// helpers that turn the saved brand color into CSS accent tokens.
// Presentation only: these values never affect authorization or data
// access, and they are always resolved from the viewer's own
// membership-scoped tenant record server-side.

/**
 * The export-ready brand structure: { name, logoUrl, brandColor }.
 * Null for a missing tenant. Future export/print code hands this to the
 * SOP export path — no display change needed there.
 */
export function getTenantBrand(tenant) {
  if (!tenant) return null;
  return {
    name: typeof tenant.name === 'string' ? tenant.name : '',
    logoUrl: typeof tenant.logo_url === 'string' ? tenant.logo_url : '',
    brandColor: typeof tenant.brand_color === 'string' ? tenant.brand_color.trim() : '',
  };
}

/**
 * Parse a #rgb / #rrggbb hex color into HSL components (0-360, 0-100,
 * 0-100). Returns null for anything unparseable.
 */
export function hexToHsl(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.trim().match(/^#(?:([0-9a-f])([0-9a-f])([0-9a-f])|([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2}))$/i);
  if (!m) return null;
  const rHex = m[4] ?? m[1] + m[1];
  const gHex = m[5] ?? m[2] + m[2];
  const bHex = m[6] ?? m[3] + m[3];
  const r = parseInt(rHex, 16) / 255;
  const g = parseInt(gHex, 16) / 255;
  const b = parseInt(bHex, 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s: s * 100, l: l * 100 };
}

/**
 * Convert a brand hex into the HSL channel string the design tokens
 * expect ("H S% L%"), adjusted for legibility in the given mode.
 * Near-white and near-black brand colors are rejected (null) so the
 * neutral MindVault palette is kept as a safe fallback.
 */
export function brandHslChannels(hex, dark) {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  if (hsl.l > 85 || hsl.l < 15) return null;
  const h = Math.round(hsl.h) % 360;
  const s = Math.round(Math.min(90, Math.max(20, hsl.s)));
  const l = dark
    ? Math.round(Math.min(72, Math.max(55, hsl.l)))
    : Math.round(Math.min(58, Math.max(32, hsl.l)));
  return `${h} ${s}% ${l}%`;
}

// The accent tokens a tenant brand may recolor: primary actions, focus
// rings, active states, and the sidebar accent marks. Semantic colors
// (destructive, success) are deliberately NOT in this list.
const BRAND_TOKENS = ['--primary', '--ring', '--sidebar-primary', '--sidebar-ring'];

/**
 * Apply the tenant brand color to the accent tokens for the current
 * color mode. Falls back to the neutral palette when the color is
 * unusable.
 */
export function applyTenantBrandTokens(hex, dark) {
  const channels = brandHslChannels(hex, dark);
  const root = document.documentElement;
  if (!channels) {
    removeTenantBrandTokens();
    return;
  }
  BRAND_TOKENS.forEach((token) => root.style.setProperty(token, channels));
}

/**
 * Remove any tenant brand overrides so the default MindVault palette
 * applies again (Super Admins, signed-out cleanup).
 */
export function removeTenantBrandTokens() {
  const root = document.documentElement;
  BRAND_TOKENS.forEach((token) => root.style.removeProperty(token));
}