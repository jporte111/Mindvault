import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { useAssignableUsers } from '@/hooks/useAssignableUsers';
import { toast } from 'sonner';

const userLabel = (u) => u?.full_name || u?.email || u?.id || 'Unknown user';

// Quick editor for the OWNER of the operational process a knowledge source is
// linked to — so a wrong owner chosen at upload can be fixed right from the
// source page instead of going to Processes. Ownership lives on the process
// (governance is authoritative there); the save goes through the guarded
// manageOperationalProcess function.
export default function ProcessOwnerSelect({ process, className = '' }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'admin';
  const users = useAssignableUsers(isSuperAdmin);
  const [saving, setSaving] = useState(false);
  const value = process?.process_owner || '';

  const handleChange = async (userId) => {
    if (!process?.id) return;
    setSaving(true);
    try {
      await base44.functions.invoke('manageOperationalProcess', {
        action: 'update',
        id: process.id,
        // A platform admin must target the record's team explicitly.
        ...(isSuperAdmin && process.tenant_id ? { tenant_id: process.tenant_id } : {}),
        fields: { process_owner: userId || null },
      });
      queryClient.invalidateQueries({ queryKey: ['operational-processes'] });
      toast.success(userId ? 'Owner updated' : 'Owner cleared');
    } catch (err) {
      toast.error('Failed to save owner: ' + (err?.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <select
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      disabled={saving || !users.length}
      aria-label="Process owner"
      className={`h-9 min-w-44 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${className}`}
    >
      <option value="">— no owner —</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>{userLabel(u)}</option>
      ))}
    </select>
  );
}