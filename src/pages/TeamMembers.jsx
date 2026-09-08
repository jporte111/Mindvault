import TenantMembersManager from '@/components/admin/TenantMembersManager';

// Team page — reachable by platform admins and Client Admins (gated in the
// navigation; the backend re-verifies authorization on every action).
export default function TeamMembers() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-8 md:py-10">
        <div className="mb-6">
          <h1 className="font-sora font-semibold text-2xl text-foreground">Team</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Invite colleagues, set their roles, and manage access to your team's knowledge.
          </p>
        </div>
        <TenantMembersManager />
      </div>
    </div>
  );
}