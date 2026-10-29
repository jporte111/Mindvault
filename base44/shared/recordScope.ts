// Which rows of a tenant-owned entity (Training, Client) a caller may read
// through the scoped read functions (listKnowledgeSources,
// getKnowledgeSource, listMyClients). Pure: no SDK, no Deno, no network.
//
// * Platform admins read every row (their existing all-workspace views).
// * Everyone else reads ONLY rows whose tenant_id equals the tenant of their
//   verified ACTIVE membership — never a tenant from the request, the
//   profile stamp, or the record itself.
// * Rows with NO tenant_id (legacy, not yet migrated) are an interim
//   exception: while LEGACY_UNTAGGED_VISIBLE is true they stay visible to
//   members, exactly as they are today, so the Library keeps working before
//   the tenant-data migration. Rows tagged with ANOTHER tenant are never
//   visible. After the migration is verified, set this to false (strict).

export const LEGACY_UNTAGGED_VISIBLE = true;

export type ReadScope =
  | { kind: 'all' }
  | { kind: 'tenant'; tenantId: string; includeUntagged: boolean };

export function readScopeFor(access: { isSuperAdmin: boolean; tenantId: string | null }): ReadScope {
  if (access.isSuperAdmin) return { kind: 'all' };
  if (!access.tenantId) throw new Error('readScopeFor: a member scope needs a tenant');
  return { kind: 'tenant', tenantId: access.tenantId, includeUntagged: LEGACY_UNTAGGED_VISIBLE };
}

const tagOf = (row: any): string | null => {
  const t = row?.tenant_id;
  return typeof t === 'string' && t.trim() ? t : null;
};

export function inReadScope(row: any, scope: ReadScope): boolean {
  if (!row) return false;
  if (scope.kind === 'all') return true;
  const tag = tagOf(row);
  if (tag === null) return scope.includeUntagged;
  return tag === scope.tenantId;
}

export function filterToScope<T>(rows: T[] | null | undefined, scope: ReadScope): T[] {
  return (rows || []).filter((r) => inReadScope(r, scope));
}

// Rows to fetch for a scope, as service-role queries: platform admins one
// unscoped query; members their tenant's rows ({ tenant_id }) plus — only
// while the legacy allowance lasts — a scan for untagged rows (the SDK has
// no reliable "field missing" filter). Results are still passed through
// filterToScope, so a query that returned too much can never leak.
export const READ_LIMIT = 5000;

export async function fetchInScope(
  entity: { filter: (q: Record<string, unknown>, sort?: string, limit?: number) => Promise<any[]> },
  scope: ReadScope,
  extra: Record<string, unknown> = {},
): Promise<{ rows: any[]; truncated: boolean }> {
  const queries: Record<string, unknown>[] = scope.kind === 'all'
    ? [{ ...extra }]
    : [{ ...extra, tenant_id: scope.tenantId }, ...(scope.includeUntagged ? [{ ...extra }] : [])];
  const seen = new Map<string, any>();
  let truncated = false;
  for (const q of queries) {
    const rows = (await entity.filter(q, undefined, READ_LIMIT)) || [];
    if (rows.length >= READ_LIMIT) truncated = true;
    for (const r of rows) if (r && !seen.has(String(r.id))) seen.set(String(r.id), r);
  }
  return { rows: filterToScope([...seen.values()], scope), truncated };
}

// Sort like the SDK's list('-created_date') / list('name') so callers keep
// their existing ordering. Only these two keys are accepted.
export function sortRows<T extends Record<string, any>>(rows: T[], sort: unknown): T[] {
  const key = sort === 'name' ? 'name' : sort === '-created_date' ? 'created_date' : null;
  if (!key) return rows;
  const dir = sort === '-created_date' ? -1 : 1;
  return [...rows].sort((a, b) => dir * String(a?.[key] ?? '').localeCompare(String(b?.[key] ?? '')));
}
