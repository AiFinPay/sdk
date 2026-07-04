export const shortAddr = (a: string) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export const fmtUsd = (n: number | string, dp = 2) => {
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return '—';
  return v < 0.01 && v > 0 ? `$${v}` : `$${v.toFixed(dp)}`;
};

export const fmtInt = (n: number) => n.toLocaleString('en-US');

export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function expiresLabel(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `expires ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** "Exa Search" from a merchant_id/resource pair — best-effort display label. */
export function merchantLabel(r: { merchant_id?: string; resource?: string }): string {
  if (r.resource && r.resource !== '/') {
    const seg = r.resource.split('/').filter(Boolean);
    if (seg.length) return seg[seg.length - 1].replace(/[-_]/g, ' ');
  }
  if (r.merchant_id) return r.merchant_id.replace(/^mrch_/, '');
  return 'service';
}
