import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BookOpen, MessageSquare, Settings, Home, LogOut, Compass, MessageCircleQuestion, ShieldCheck, CircleHelp, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { base44 } from '@/api/base44Client';
import AccountSettingsDialog from './AccountSettingsDialog';
import NotificationBell from '../notifications/NotificationBell';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import { useTenantRole } from '@/hooks/useTenantRole';

const navItems = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/library', icon: BookOpen, label: 'Knowledge' },
  { path: '/chat', icon: MessageSquare, label: 'AI Assistant' },
];

const adminItems = [
  { path: '/roadmap', icon: Compass, label: 'Strategy Engine' },
  { path: '/admin', icon: Settings, label: 'Admin' },
  { path: '/team', icon: Users, label: 'Team' },
];

export default function Sidebar({ user, onOpenHelp }) {
  const location = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { clarificationsEnabled, knowledgeHealthEnabled } = useSystemConfig();
  const { isClientAdmin } = useTenantRole();
  const items = clarificationsEnabled
    ? [...navItems, { path: '/my-questions', icon: MessageCircleQuestion, label: 'My questions' }]
    : navItems;
  const adminNav = knowledgeHealthEnabled
    ? [{ path: '/continuity', icon: ShieldCheck, label: 'Operational Continuity' }, ...adminItems]
    : adminItems;

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-sidebar hidden md:flex flex-col z-50 border-r border-sidebar-border">
      {/* Logo */}
      <div className="px-6 py-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-sidebar-primary flex items-center justify-center shadow-lg">
            <BookOpen className="w-5 h-5 text-sidebar-primary-foreground" />
          </div>
          <div>
            <p className="text-sidebar-foreground font-sora font-semibold text-sm leading-tight">Knowledge</p>
            <p className="text-sidebar-foreground/50 text-xs">Base</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map(({ path, icon: Icon, label }) => (
          <Link
            key={path}
            to={path}
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all duration-150',
              location.pathname === path || (path === '/chat' && location.pathname === '/chat')
                ? 'bg-primary text-white shadow-md shadow-primary/30'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            )}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {label}
          </Link>
        ))}

        {user?.role === 'admin' && (
          <>
            <div className="pt-4 pb-2 px-3">
              <p className="text-sidebar-foreground/30 text-xs font-semibold uppercase tracking-widest">Admin</p>
            </div>
            {adminNav.map(({ path, icon: Icon, label }) => (
              <Link
                key={path}
                to={path}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all duration-150',
                  location.pathname === path
                    ? 'bg-primary text-white shadow-md shadow-primary/30'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </Link>
            ))}
          </>
        )}

        {user?.role !== 'admin' && isClientAdmin && (
          <>
            <div className="pt-4 pb-2 px-3">
              <p className="text-sidebar-foreground/30 text-xs font-semibold uppercase tracking-widest">Manage</p>
            </div>
            <Link
              to="/team"
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all duration-150',
                location.pathname === '/team'
                  ? 'bg-primary text-white shadow-md shadow-primary/30'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              )}
            >
              <Users className="w-4 h-4 flex-shrink-0" />
              Team
            </Link>
          </>
        )}
      </nav>

      {/* User */}
      <div className="px-3 py-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3 px-3 py-2 rounded-xl">
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
            <span className="text-primary text-xs font-semibold">
              {user?.full_name?.charAt(0)?.toUpperCase() || '?'}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sidebar-foreground text-xs font-medium truncate">{user?.full_name || 'User'}</p>
            <p className="text-sidebar-foreground/40 text-xs truncate">{user?.role || 'user'}</p>
          </div>
          <div className="flex items-center gap-1">
            <NotificationBell />
            {user?.role === 'admin' && (
              <button
                onClick={onOpenHelp}
                className="flex items-center justify-center w-9 h-9 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                aria-label="Help"
                title="Help"
              >
                <CircleHelp className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex items-center justify-center w-9 h-9 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              aria-label="Account settings"
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              onClick={() => base44.auth.logout()}
              className="flex items-center justify-center w-9 h-9 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              aria-label="Log out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
      <AccountSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </aside>
  );
}