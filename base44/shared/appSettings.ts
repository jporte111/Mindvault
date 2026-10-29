// AppConfig split: which settings non-admin UI may read. Pure: no SDK, no
// Deno, no network. AppConfig holds global feature flags (no tenant data, no
// secrets), but the governance / retrieval / observability switches are
// administrative, so direct AppConfig reads are admin-only and everyone else
// gets exactly this allowlist from getAppSettings.
//
// Each field below is read by a page or component a regular member can
// reach (Chat, MyQuestions, Sidebar, source detail). Add a field only when
// member UI needs it.
export const MEMBER_VISIBLE_SETTINGS: Record<string, readonly string[]> = {
  chat: ['chat_engine', 'rag_rollout_pct'],
  system: [
    'knowledge_gaps_enabled',
    'clarifications_enabled',
    'knowledge_health_enabled',
    'source_lifecycle_enabled',
    // Shown read-only to client admins (AssistantSettings -> AssistantToggles).
    'require_verification_for_retrieval',
    'answer_logging_enabled',
  ],
};

/** The member view of one AppConfig row: allowlisted fields only, no id. */
export function memberView(key: string, row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  const out: Record<string, unknown> = { key };
  for (const f of MEMBER_VISIBLE_SETTINGS[key] || []) if (f in row) out[f] = row[f];
  return out;
}
