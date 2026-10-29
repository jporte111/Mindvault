# Entity access hardening

Direct entity reads no longer expose tenant data. Before this change,
`Training`, `Client` and `AppConfig` were readable by anyone the app let in
(`read: true`), and five entities granted access by matching
`{{user.data.tenant_id}}` — a profile field users can write themselves
(`auth.updateMe`), so it could be pointed at another tenant. Three entities
had no RLS at all. Checked by `scripts/rag-eval/entity-access.test.mjs`.

## Access after this change

| Entity | Direct access (RLS) | Members read through |
|---|---|---|
| Training | admin only | `listKnowledgeSources`, `getKnowledgeSource` |
| Client | admin only | `listMyClients`; writes via `manageClients` |
| Tenant | admin only | `getMyWorkspace` (display fields only), `listMyWorkspaces` |
| AppConfig | admin only | `getAppSettings` (member allowlist in `shared/appSettings.ts`) |
| KnowledgeGap, KnowledgeFeedback | admin only | existing backend functions |
| RecurringPainPoint, WorkflowPattern, DecisionRulePattern, ProductOpportunityCluster, ProductRecommendation | admin only | platform Strategy Engine only |

The only RLS template left anywhere is `{{user.id}}` (Notification,
TenantMembership — own rows).

The read functions resolve the tenant from the caller's verified ACTIVE
membership (`requireReadAccess` in `shared/tenant.ts`): anonymous → 401;
no / pending / inactive membership or suspended workspace → 403; unknown
workspace → 400; several workspaces without a valid selection → 409.
Another tenant's record gets the same 404 as a missing one. Platform admins
keep their all-workspace views.

Writes that moved server-side:

- `manageClients` — client admins of an active workspace manage only their
  own tenant's clients; `tenant_id` comes from the verified scope and is
  never patchable; delete is refused while any source or process references
  the client.
- `analyzeTraining` — platform admins, or a client admin of the source's own
  active tenant.

## Production variant (hotfix on 396aaef)

Production has no workspace selection (Release A is not deployed). Its
`requireReadAccess` uses production's `resolveTenantContext`: a body
`workspaceId` is ignored, and a non-admin with ACTIVE memberships in more
than one tenant is refused (409) instead of being scoped to one. The
OperationalProcess and KnowledgeChunk read rules are admin-only here too
(staging got those in earlier commits). Chat (V1 and V2) refuses anonymous
callers and anyone without an active membership in an active tenant.

## Interim: legacy untagged rows

`LEGACY_UNTAGGED_VISIBLE = true` (`shared/recordScope.ts`): Training and
Client rows with no `tenant_id` stay visible to members, as they are today,
so the Library keeps working before the tenant-data migration. Rows tagged
with another tenant are never visible. **Release gate:** run and verify the
migration, then set it to `false`, before onboarding a second real tenant.

## Deployment notes

- No data migration is needed; no records change.
- Verify in staging (synthetic data): anonymous → 401 everywhere; a member
  sees only their workspace's sources and clients; platform-admin screens
  (`/admin`, `/roadmap`) work for admins and show nothing to others.
- Confirm Base44 semantics before production: `auth.updateMe` cannot change
  the built-in `role`; denied RLS reads return empty/errors (not data).
- Rollback: revert the commit. RLS returns to its previous rules; no data
  is affected.
