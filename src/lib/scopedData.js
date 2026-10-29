import { base44 } from '@/api/base44Client';

// Tenant-scoped reads for member-facing UI. Training, Client, Tenant and
// AppConfig direct entity reads are admin-only (RLS); these backend
// functions resolve the caller's tenant from their verified membership and
// return only what the caller may see. The selected workspace rides along
// automatically (base44Client wraps functions.invoke). Platform-admin-only
// screens may keep reading entities directly.
const unwrap = (res) => res?.data ?? res;

/**
 * Knowledge sources (Training rows) the caller may see.
 * @param {{ status?: string, sort?: string }} [opts]
 */
export async function listKnowledgeSources({ status, sort = '-created_date' } = {}) {
  const data = unwrap(await base44.functions.invoke('listKnowledgeSources', { status, sort }));
  return data?.sources ?? [];
}

/** One knowledge source by id; throws (404) when missing or not visible. */
export async function getKnowledgeSource(id) {
  const data = unwrap(await base44.functions.invoke('getKnowledgeSource', { id }));
  return data?.source ?? null;
}

/** Client rows the caller may see, sorted by name. */
export async function listMyClients() {
  const data = unwrap(await base44.functions.invoke('listMyClients', {}));
  return data?.clients ?? [];
}

/** The caller's own workspace profile (display fields only), or null. */
export async function getMyWorkspace() {
  const data = unwrap(await base44.functions.invoke('getMyWorkspace', {}));
  return data?.workspace ?? null;
}

/** AppConfig rows { chat, system }: full rows for platform admins, the member allowlist otherwise. */
export async function getAppSettings() {
  const data = unwrap(await base44.functions.invoke('getAppSettings', {}));
  return data?.settings ?? {};
}

/** Client management (create / update / delete) through the authorized function. */
export async function manageClient(payload) {
  return unwrap(await base44.functions.invoke('manageClients', payload));
}
