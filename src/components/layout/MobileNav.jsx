import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Home, BookOpen, MessageSquare, ChevronLeft, Settings, Compass, CircleHelp, Users, Rocket } from 'lucide-react';
import { cn } from '@/lib/utils';
import AccountSettingsDialog from './AccountSettingsDialog';
import NotificationBell from '../notifications/NotificationBell';
import { useTenantRole } from '@/hooks/useTenantRole';

const rootTabs = ['/', '/library', '/chat'];

function titleFor(pathname) {
  if (pathname.startsWith('/training/')) return 'Knowledge Source';
  if (pathname === '/roadmap') return 'Strategy Engine';
  if (pathname === '/admin') return 'Admin';
  if (pathname === '/team') return 'Team';
  if (pathname === '/setup') return 'Getting Started';
  if (pathname === '/manage') return 'Manage';
  return 'Knowledge Base';
}

export default function MobileNav({ user, onOpenHelp }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { isClientAdmin } = useTenantRole();
  const tabs = [
    { path: '/', icon: Home, label: 'Home' },
    { path: '/library', icon: BookOpen, label: 'Knowledge' },
    { path: '/chat', icon: MessageSquare, label: 'Chat' },
    ...(user?.role === 'admin' ? [
      { path: '/roadmap', icon: Compass, label: 'Strategy' },
      { path: '/admin', icon: Settings, label: 'Admin' },
      { path: '/team', icon: Users, label: 'Team' },
    ] : isClientAdmin ? [
      { path: '/setup', icon: Rocket, label: 'Setup' },
      { path: '/manage', icon: Settings, label: 'Manage' },
      { path: '/team', icon: Users, label: 'Team' },
    ] : []),
  ];

  const isRoot = tabs.some(tab => tab.path === location.pathname);

  return (
    <>
      {/* Top bar — mobile only */}
      <header className="md:hidden fixed top-0 inset-x-0 z-50 bg-card border-b border-border pt-[env(safe-area-inset-top)]">
        <div className="h-14 flex items-center px-3 gap-2">
          {!isRoot && (
            <button
              onClick={() => navigate(-1)}
              className="flex items-center justify-center w-11 h-11 -ml-1 rounded-lg text-foreground hover:bg-accent transition-colors"
              aria-label="Back"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          <span className="flex-1 font-sora font-semibold text-foreground text-base truncate">
            {titleFor(location.pathname)}
          </span>
          <NotificationBell />
          {user?.role === 'admin' && (
            <button
              onClick={onOpenHelp}
              className="flex items-center justify-center w-11 h-11 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label="Help"
              title="Help"
            >
              <CircleHelp className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center justify-center w-11 h-11 -mr-1 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="Account settings"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Bottom tab nav — mobile only */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-card border-t border-border pb-[env(safe-area-inset-bottom)]">
        <div className="flex">
          {tabs.map(({ path, icon: Icon, label }) => {
            const active = location.pathname === path;
            return (
              <Link
                key={path}
                to={path}
                className={cn(
                  'flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[56px] text-xs font-medium transition-colors',
                  active ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                <Icon className="w-5 h-5" />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>

      <AccountSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}