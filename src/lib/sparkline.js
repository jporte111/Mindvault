// Phase 9 P9-2 — pure SVG sparkline geometry for the /continuity Trends panel.
// No imports, no React. x positions come from the ACTUAL calendar-month offset
// of each point's period_key, and the path is BROKEN (a new `M` subpath) across
// any gap of more than one month. A missing month is therefore visually
// discontinuous — nothing is interpolated, zero-filled, or synthesized.

/** 'YYYY-MM' -> an absolute month index (year*12 + month). null if unparseable. */
export function monthOrdinal(periodKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey || ''));
  if (!m) return null;
  return Number(m[1]) * 12 + Number(m[2]);
}

/**
 * @param {{period_key:string, value:number}[]} points  chronological, real rows only
 * @param {{width?:number,height?:number,pad?:number,min?:number,max?:number}} [opts]
 * @returns {{ d:string, dots:{x:number,y:number,period_key:string}[], segments:number, points:number }}
 *   `d` is an SVG path with one `M` per contiguous run of adjacent months and
 *   `L` within a run; `segments` = number of `M` commands (>1 means a gap break).
 */
export function buildSparklinePath(points, opts = {}) {
  const width = opts.width ?? 88;
  const height = opts.height ?? 22;
  const pad = opts.pad ?? 2;

  const pts = (Array.isArray(points) ? points : []).filter(
    (p) => p && typeof p.value === 'number' && Number.isFinite(p.value) && monthOrdinal(p.period_key) != null,
  );
  if (pts.length === 0) return { d: '', dots: [], segments: 0, points: 0 };

  const ords = pts.map((p) => monthOrdinal(p.period_key));
  const firstOrd = ords[0];
  const lastOrd = ords[ords.length - 1];
  const monthSpan = Math.max(1, lastOrd - firstOrd); // real elapsed months, gaps included

  const values = opts.min != null && opts.max != null
    ? { min: opts.min, max: opts.max }
    : { min: Math.min(...pts.map((p) => p.value)), max: Math.max(...pts.map((p) => p.value)) };
  const valueSpan = Math.max(1, values.max - values.min);

  const xy = pts.map((p, i) => {
    const x = pad + ((ords[i] - firstOrd) / monthSpan) * (width - pad * 2);
    const y = height - pad - ((p.value - values.min) / valueSpan) * (height - pad * 2);
    return { x, y, period_key: p.period_key };
  });

  let d = '';
  let segments = 0;
  for (let i = 0; i < xy.length; i++) {
    const adjacent = i > 0 && ords[i] - ords[i - 1] === 1;
    const cmd = adjacent ? 'L' : 'M';
    if (cmd === 'M') segments += 1;
    d += `${d ? ' ' : ''}${cmd}${xy[i].x.toFixed(1)},${xy[i].y.toFixed(1)}`;
  }

  return { d, dots: xy, segments, points: xy.length };
}
