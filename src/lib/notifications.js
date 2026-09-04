import { base44 } from '@/api/base44Client';

// Phase 8 P8-3 client helper. Recipients act ONLY through the guarded backend
// functions — never a direct entity write (Notification RLS stays admin-only
// for create/update/delete). The single direct SDK use is a read, explicitly
// scoped to the current user's own episodes.

const unwrap = (p) => p.then((r) => r?.data ?? r);

export async function fetchMyNotifications() {
  const me = await base44.auth.me();
  return unwrap(base44.entities.Notification.filter({ recipient_user_id: me.id }, '-created_date', 200));
}

export function markNotificationRead(id) {
  return unwrap(base44.functions.invoke('markNotificationRead', { id }));
}

export function dismissNotification(id) {
  return unwrap(base44.functions.invoke('dismissNotification', { id }));
}