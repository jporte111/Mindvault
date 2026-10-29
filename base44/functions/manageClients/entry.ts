import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  assertActiveTenant,
  requireExplicitTenantAdminScope,
  requireTenantAdminScope,
  TenantAuthError,
} from '../../shared/tenant.ts';

// Client records: create / rename / archive / delete. Client direct writes are
// admin-only; before this, the RLS let any user whose user-writable profile
// stamp matched a client's tenant create, change or DELETE it.
//  * Platform admins may manage any client; a new client needs an explicit
//    tenant (or their single own client_admin workspace).
//  * Client admins of an ACTIVE workspace manage only their own tenant's clients;
//    another tenant's client (or a legacy untagged one) gets the same 404 as
//    a missing one. Client users are refused.
//  * tenant_id is set ONLY from the verified scope on create and is never
//    changed afterwards.
//  * Delete refuses while any knowledge source or process still references
//    the client (409), so no knowledge becomes unreachable. Nothing else is
//    deleted.
const STATUSES = new Set(['active', 'archived']);

export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');
    const audit = (entity_id: string, act: string, summary: string, before: unknown, after: unknown) =>
      base44.asServiceRole.entities.AuditEvent.create({
        entity: 'Client', entity_id, action: act, actor_type: 'user', actor_user_id: user.id, summary,
        before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
      }).catch(() => {});

    if (action === 'create') {
      const name = String(body?.name ?? '').trim();
      if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
      const scope = await requireExplicitTenantAdminScope(base44, body?.tenantId ?? null);
      await assertActiveTenant(base44, scope.tenantId);
      const client = await base44.asServiceRole.entities.Client.create({ name, status: 'active', tenant_id: scope.tenantId });
      await audit(client.id, 'client_created', `Created client ${name}`, null, { name, tenant_id: scope.tenantId });
      return Response.json({ client });
    }

    if (action !== 'update' && action !== 'delete') {
      return Response.json({ error: 'action must be create, update or delete' }, { status: 400 });
    }
    const clientId = String(body?.clientId ?? '').trim();
    if (!clientId) return Response.json({ error: 'clientId is required' }, { status: 400 });

    // Authorize the caller BEFORE looking at the record.
    const isPlatformAdmin = user.role === 'admin';
    const scope = isPlatformAdmin ? null : await requireTenantAdminScope(base44, null);
    // A suspended / archived workspace changes nothing (same as createKnowledgeSource).
    if (scope) await assertActiveTenant(base44, scope.tenantId);
    const client = await base44.asServiceRole.entities.Client.get(clientId).catch(() => null);
    if (!client || (scope && client.tenant_id !== scope.tenantId)) {
      return Response.json({ error: 'Client not found' }, { status: 404 });
    }

    if (action === 'update') {
      const patch: Record<string, unknown> = {};
      if (body?.name !== undefined) {
        const name = String(body.name ?? '').trim();
        if (!name) return Response.json({ error: 'name cannot be empty' }, { status: 400 });
        patch.name = name;
      }
      if (body?.status !== undefined) {
        if (!STATUSES.has(body.status)) return Response.json({ error: 'status must be active or archived' }, { status: 400 });
        patch.status = body.status;
      }
      if (!Object.keys(patch).length) return Response.json({ error: 'nothing to update' }, { status: 400 });
      const updated = await base44.asServiceRole.entities.Client.update(clientId, patch);
      await audit(clientId, 'client_updated', `Updated client ${client.name}`,
        { name: client.name, status: client.status }, patch);
      return Response.json({ client: updated });
    }

    // delete
    const [sources, processes] = await Promise.all([
      base44.asServiceRole.entities.Training.filter({ client_id: clientId }, undefined, 1).catch(() => null),
      base44.asServiceRole.entities.OperationalProcess.filter({ client_id: clientId }, undefined, 1).catch(() => null),
    ]);
    if (sources === null || processes === null) {
      return Response.json({ error: 'Could not confirm the client has no linked knowledge' }, { status: 503 });
    }
    if (sources.length || processes.length) {
      return Response.json({
        error: 'client_has_knowledge: reclassify or archive the linked knowledge first',
      }, { status: 409 });
    }
    await base44.asServiceRole.entities.Client.delete(clientId);
    await audit(clientId, 'client_deleted', `Deleted client ${client.name}`,
      { name: client.name, status: client.status, tenant_id: client.tenant_id ?? null }, null);
    return Response.json({ deleted: true });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: (error as Error)?.message || 'Internal error' }, { status: 500 });
  }
}
