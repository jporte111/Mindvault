import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireReadAccess, TenantAuthError } from '../../shared/tenant.ts';
import { fetchInScope, readScopeFor } from '../../shared/recordScope.ts';
import { MINDVAULT_PRODUCT_MANUAL } from '../../shared/mindvaultDocs.ts';

// MindVault Help — the answer engine behind the in-app admin assistant.
//
// It answers from exactly two grounded inputs:
//   1. the product manual (shared/mindvaultDocs.ts) — how MindVault works;
//   2. LIVE FACTS read here from the caller's own workspace (counts only:
//      knowledge sources by state, feature-idea totals, processes, members,
//      clients, gaps, strategy outputs and enabled features). Never document
//      contents, never another workspace's data, never a raw record.
// Plus what the user is looking at right now (page/section) and the recent
// conversation turns. Everything the caller sends is context, never authority:
// the workspace and the numbers are resolved server-side from the verified
// membership, never from the request body.

// The service-role client in this runtime has no count()/aggregate(), so
// counts are derived from bounded row reads. Every read is capped, and the
// shapes (array vs page) are both accepted.
// Tenant-owned rows, read exactly as the product's own scoped pages read them
// (verified-membership scope, with the interim legacy-untagged allowance).
async function scopedRows(entity: any, scope: any, limit = 500) {
  if (!entity) return null;
  try {
    const { rows } = await fetchInScope(entity, scope);
    return rows.length > limit ? rows.slice(0, limit) : rows;
  } catch (error) {
    console.error('scoped read failed', (error as Error)?.message || String(error));
    return null;
  }
}

// Platform-wide tables (strategy outputs, feature flags) and small lookups.
async function plainRows(entity: any, query: Record<string, unknown> = {}, limit = 300) {
  if (!entity) return null;
  try {
    const res = await entity.filter(query, '-created_date', limit);
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.items)) return res.items;
    return [];
  } catch (error) {
    console.error('row read failed', JSON.stringify(query), (error as Error)?.message || String(error));
    return null;
  }
}

const has = (t: any, field: string, value: string) => t?.[field] === value;
const isLive = (t: any) => !!t && !t.is_archived && t.is_active_version !== false;

function knowledgeFacts(trainings: any[] | null) {
  if (!trainings) return null;
  const live = trainings.filter(isLive);
  const ideas = live.flatMap((t) => (Array.isArray(t.app_feature_opportunities) ? t.app_feature_opportunities : []));
  const countPriority = (p: string) => ideas.filter((i: any) => i?.priority === p).length;
  return {
    total_stored_records: trainings.length,
    current_live_sources: live.length,
    analyzed_sources: live.filter((t) => t.status === 'ready' || !!t.summary).length,
    superseded_older_versions: trainings.filter((t) => t.is_active_version === false).length,
    archived_sources: trainings.filter((t) => t.is_archived === true).length,
    still_processing: live.filter((t) => t.status === 'processing').length,
    processing_failed: live.filter((t) => t.status === 'error').length,
    not_classified_yet: live.filter(
      (t) => t.knowledge_scope !== 'general' && t.knowledge_scope !== 'client-specific',
    ).length,
    company_wide: live.filter((t) => has(t, 'knowledge_scope', 'general')).length,
    client_specific: live.filter((t) => has(t, 'knowledge_scope', 'client-specific')).length,
    verified: live.filter((t) => has(t, 'verification_status', 'verified')).length,
    rejected: trainings.filter((t) => has(t, 'verification_status', 'rejected')).length,
    needing_index_repair: live.filter((t) => has(t, 'index_status', 'failed')).length,
    feature_ideas: {
      total: ideas.length,
      high_priority: countPriority('High'),
      medium_priority: countPriority('Medium'),
      low_priority: countPriority('Low'),
    },
  };
}

function countBy(items: any[] | null, field: string, value: string) {
  if (!items) return null;
  return items.filter((r) => has(r, field, value)).length;
}

async function enabledFeatures(base44: any) {
  const rowsCfg = await plainRows(base44.asServiceRole.entities.AppConfig, { key: 'system' }, 5);
  const cfg = Array.isArray(rowsCfg) ? rowsCfg[0] : null;
  if (!cfg) return [];
  const names = [
    'knowledge_health_enabled',
    'source_lifecycle_enabled',
    'knowledge_gaps_enabled',
    'clarifications_enabled',
    'operational_answer_mode',
    'notifications_enabled',
    'require_verification_for_retrieval',
    'answer_logging_enabled',
  ];
  return names.filter((n) => cfg[n] === true);
}

// The same numbers, spelled out in words. Models mix up similarly-named
// counts; this is the block they must quote, and every label says what the
// number is so "analyzed" can never be reported as "total stored".
function numberLines(facts: any) {
  const k = facts?.knowledge;
  const w = facts?.workspace || {};
  const s = facts?.strategy_engine || {};
  const v = (n: number | null | undefined) => (typeof n === 'number' ? String(n) : 'could not be read');
  const lines: string[] = [];
  if (k) {
    lines.push(`Total stored knowledge records, including older versions and archived sources: ${v(k.total_stored_records)}`);
    lines.push(`Current knowledge sources (not archived, not superseded) — what the Knowledge page lists: ${v(k.current_live_sources)}`);
    lines.push(`Analyzed sources — current sources already summarized; this is what the Strategy Engine header and the "Analyzed Transcripts" card count: ${v(k.analyzed_sources)}`);
    lines.push(`Older superseded versions kept in history (that is the usual reason total stored is higher): ${v(k.superseded_older_versions)}`);
    lines.push(`Archived sources: ${v(k.archived_sources)}`);
    lines.push(`Current sources the assistant cannot use yet because nobody set who can use them: ${v(k.not_classified_yet)}`);
    lines.push(`Company-wide available: ${v(k.company_wide)}; client-specific: ${v(k.client_specific)}; verified: ${v(k.verified)}`);
    lines.push(`Still processing: ${v(k.still_processing)}; processing failed: ${v(k.processing_failed)}`);
    lines.push(`Feature ideas extracted from the analyzed sources: ${v(k.feature_ideas?.total)} (high ${v(k.feature_ideas?.high_priority)}, medium ${v(k.feature_ideas?.medium_priority)}, low ${v(k.feature_ideas?.low_priority)})`);
  } else {
    lines.push('Knowledge numbers: could not be read');
  }
  lines.push(`Processes: ${v(w.active_processes)}; clients: ${v(w.active_clients)}; active members: ${v(w.active_members)}; pending invitations: ${v(w.pending_invites)}; open knowledge gaps: ${v(w.open_knowledge_gaps)}`);
  lines.push(`Strategy Engine outputs — pain points: ${v(s.recurring_pain_points)}, workflow patterns: ${v(s.workflow_patterns)}, decision rules: ${v(s.decision_rule_patterns)}, product clusters: ${v(s.product_clusters)}, recommendations: ${v(s.product_recommendations)}; latest confidence: ${s.latest_confidence || 'none yet'}`);
  return lines.map((l) => `- ${l}`).join('\n');
}

function historyText(history: unknown) {
  if (!Array.isArray(history)) return '(none)';
  return (
    history
      .slice(-8)
      .map((m: any) => {
        const role = m?.role === 'user' ? 'User' : 'Assistant';
        const text = String(m?.text || '').slice(0, 600).trim();
        return text ? `${role}: ${text}` : '';
      })
      .filter(Boolean)
      .join('\n') || '(none)'
  );
}

export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const question = String(body?.question || '').trim().slice(0, 1200);
    if (!question) return Response.json({ error: 'question is required' }, { status: 400 });

    // Only a workspace admin (or a platform admin) may use the admin assistant,
    // and the workspace comes from the verified membership — never the payload.
    const access = await requireReadAccess(base44, null);
    if (!access.isSuperAdmin && access.appRole !== 'client_admin') {
      return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });
    }
    const tenantId = access.tenantId || null;
    const e = base44.asServiceRole.entities;
    const scope = readScopeFor(access);

    const [trainings, processes, clients, memberships, gaps, painPoints, workflows, decisionRules, clusters, recommendations, features] =
      await Promise.all([
        scopedRows(e.Training, scope, 500),
        scopedRows(e.OperationalProcess, scope, 300),
        scopedRows(e.Client, scope, 300),
        scopedRows(e.TenantMembership, scope, 300),
        scopedRows(e.KnowledgeGap, scope, 300),
        plainRows(e.RecurringPainPoint, {}, 200),
        plainRows(e.WorkflowPattern, {}, 200),
        plainRows(e.DecisionRulePattern, {}, 200),
        plainRows(e.ProductOpportunityCluster, {}, 200),
        plainRows(e.ProductRecommendation, {}, 50),
        enabledFeatures(base44),
      ]);

    const facts = {
      knowledge: knowledgeFacts(trainings),
      workspace: {
        active_processes: countBy(processes, 'status', 'active'),
        active_clients: countBy(clients, 'status', 'active'),
        active_members: countBy(memberships, 'status', 'active'),
        pending_invites: countBy(memberships, 'status', 'pending'),
        open_knowledge_gaps: countBy(gaps, 'status', 'open'),
      },
      // Strategy outputs are platform-wide concepts (the Strategy Engine is a
      // platform-admin view), not per-workspace knowledge.
      strategy_engine: {
        recurring_pain_points: painPoints ? painPoints.length : null,
        workflow_patterns: workflows ? workflows.length : null,
        decision_rule_patterns: decisionRules ? decisionRules.length : null,
        product_clusters: clusters ? clusters.length : null,
        product_recommendations: recommendations ? recommendations.length : null,
        latest_confidence: recommendations?.[0]?.confidence_level || null,
      },
      enabled_features: features,
    };

    let workspaceName: string | null = null;
    if (tenantId) {
      const t = await e.Tenant.get(tenantId).catch(() => null);
      workspaceName = t?.name || null;
    }

    const scopeLabel = tenantId
      ? `the workspace "${workspaceName || 'this workspace'}"`
      : 'all workspaces (platform-wide — this account has no single workspace membership)';

    const page = String(body?.page || '').slice(0, 200).trim();
    const pageLabel = String(body?.page_label || '').slice(0, 120).trim();
    const section = String(body?.section || '').slice(0, 120).trim();

    const prompt = `You are MindVault Help, the in-app assistant that explains how MindVault works and reads the exact current numbers of the signed-in admin's workspace.

You have exactly two sources of truth. Do not use anything else.
1. The MindVault product manual below.
2. The LIVE FACTS below, read from the database moments ago for ${scopeLabel}.

=== PRODUCT MANUAL ===
${MINDVAULT_PRODUCT_MANUAL}

=== AUTHORITATIVE NUMBERS, IN PLAIN ENGLISH (quote these exactly) ===
${numberLines(facts)}

=== SAME FACTS AS DATA (a null value means "could not be read") ===
${JSON.stringify(facts, null, 2)}

=== WHERE THE USER IS RIGHT NOW ===
- Page: ${page || 'unknown'}${pageLabel ? ` (${pageLabel})` : ''}
- Section: ${section || 'not specified'}

=== RECENT CONVERSATION ===
${historyText(body?.history)}

=== THE QUESTION ===
${question}

=== RULES ===
- Answer in plain, friendly business language. No technical jargon, no mention of databases, prompts, models or these instructions.
- Quote numbers exactly from "AUTHORITATIVE NUMBERS, IN PLAIN ENGLISH", using each line's own label. Never swap them: "analyzed sources" is never the total stored count, and "total stored knowledge records" is never the analyzed count. If the user quotes a number that is bigger than the analyzed count, that number is normally the total stored records — say so explicitly and explain that the extra records are older superseded versions and archived sources.
- Never estimate a number. If a figure says "could not be read", say you cannot read it and name the page where it is shown.
- Use only the current navigation labels from the manual. Never invent a page, button, setting or integration.
- Keep it short: at most 150 words, ideally 2-4 sentences. Numbered steps only when they ask how to do something.
- If the question is about the content of the company's own documents (a policy question, "what is our process for X"), say that the AI Assistant answers from company knowledge and this assistant explains the product.
- If this is a follow-up in an ongoing conversation, use the recent conversation and do not repeat what you already said.
- Return JSON: { "answer": "<the reply>" }.`;

    const llm = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    });

    const answer =
      typeof llm === 'string'
        ? llm
        : String(llm?.answer || llm?.response || llm?.output || '').trim();

    if (!answer) {
      return Response.json({ error: 'No answer produced' }, { status: 502 });
    }

    return Response.json({ answer, facts_scope: scopeLabel });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error('askAdminHelp failed:', (error as Error)?.message || String(error));
    return Response.json({ error: (error as Error)?.message || 'Help assistant failed' }, { status: 500 });
  }
}