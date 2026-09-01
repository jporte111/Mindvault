// Server-side visibility rule for OperationalProcess reads.
//
// OperationalProcess RLS is admin-only for every operation (create/read/update/
// delete), so direct entity reads return nothing for non-admins. This module is
// the single authority for what a non-admin is allowed to see, used by the
// listOperationalProcesses backend function.
//
// The app's User entity has only { role }. There is NO user<->client
// relationship anywhere, so client-specific visibility CANNOT be authorized per
// user without inventing a permission model. Until such a model exists:
//
//   admin           -> all processes
//   any other user  -> organization-wide ('general') processes only
//                      (never 'client-specific', never 'unclassified')
//
// Pure — no Base44 / network. Deno + Node both import it.

export interface MinimalUser {
  role?: string | null;
}

export interface ScopedProcess {
  knowledge_scope?: string | null;
  [k: string]: unknown;
}

export function visibleProcesses<T extends ScopedProcess>(
  user: MinimalUser | null | undefined,
  processes: T[],
): T[] {
  if (!user) return [];
  if (user.role === "admin") return processes;
  return (processes || []).filter((p) => p?.knowledge_scope === "general");
}
