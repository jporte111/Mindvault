import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BookOpen, MessageSquare, Settings, Home, LogOut, Compass, MessageCircleQuestion, ShieldCheck, Users, Workflow, Bot, LayoutDashboard, Cable } from 'lucide-react';
import { cn } from '@/lib/utils';
import { base44 } from '@/api/base44Client';
import AccountSettingsDialog from './AccountSettingsDialog';
import NotificationBell from '../notifications/NotificationBell';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import { useTenantRole } from '@/hooks/useTenantRole';
import { useTenantBrand } from '@/hooks/useClientSetup';
import TenantLogoMark from '../common/TenantLogoMark';
import { OPEN_HELP_EVENT } from '@/components/onboarding/AdminHelpAssistant';

// Employee navigation — simple for everyone.
const employeeItems = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/library', icon: BookOpen, label: 'Knowledge' },
  { path: '/chat', icon: MessageSquare, label: 'AI Assistant' },
  { path: '/connect', icon: Bot, label: 'Connect AI' },
];

// Company administration — six clear areas for the company admin.
const companyAdminItems = [
  { path: '/overview', icon: LayoutDashboard, label: 'Overview' },
  { path: '/knowledge', icon: BookOpen, label: 'Knowledge' },
  { path: '/processes', icon: Workflow, label: 'Processes' },
  { path: '/assistant', icon: Bot, label: 'Assistant' },
  { path: '/company', icon: Users, label: 'Company & Team' },
  { path: '/connections', icon: Cable, label: 'Connections' },
];
const continuityItem = { path: '/continuity', icon: ShieldCheck, label: 'Operational Continuity' };

// Platform administration — separate from company administration.
const platformItems = [
  { path: '/roadmap', icon: Compass, label: 'Strategy Engine' },
  { path: '/admin', icon: Settings, label: 'Platform settings' },
];

const linkClass = (active) => cn(
  'flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all duration-150',
  active
    ? 'bg-primary text-white shadow-md shadow-primary/30'
    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
);

export default function Sidebar({ user, onOpenHelp }) {
  const location = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { knowledgeHealthEnabled } = useSystemConfig();
  const { isClientAdmin } = useTenantRole();
  const brand = useTenantBrand();

  const isSuperAdmin = user?.role === 'admin';
  const subtitle = brand?.name || (isSuperAdmin ? 'Platform' : '');

  const renderItem = ({ path, icon: Icon, label }) => (
    <Link key={path} to={path} className={linkClass(location.pathname === path)}>
      <Icon className="w-4 h-4 flex-shrink-0" />
      {label}
    </Link>
  );

  const renderSection = (title, items) => (
    <>
      <div className="pt-4 pb-2 px-3">
        <p className="text-sidebar-foreground/30 text-xs font-semibold uppercase tracking-widest">{title}</p>
      </div>
      {items.map(renderItem)}
    </>
  );

  const companySection = knowledgeHealthEnabled ? [...companyAdminItems, continuityItem] : companyAdminItems;

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-sidebar hidden md:flex flex-col z-50 border-r border-sidebar-border">
      {/* Brand — MindVault, with the member's company beneath it */}
      <div className="px-6 py-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-sidebar-primary flex items-center justify-center shadow-lg">
            <BookOpen className="w-5 h-5 text-sidebar-primary-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-sidebar-foreground font-sora font-semibold text-sm leading-tight">MindVault</p>
            {subtitle && (
              <p className="flex items-center gap-1.5 min-w-0 text-sidebar-foreground/50 text-xs">
                {brand && (
                  <TenantLogoMark
                    name={brand.name}
                    logoUrl={brand.logoUrl}
                    brandColor={brand.brandColor}
                    className="w-4 h-4 rounded"
                  />
                )}
                <span className="truncate">{subtitle}</span>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {isSuperAdmin ? (
          <>
            {employeeItems.map(renderItem)}
            {renderSection('Company administration', companySection)}
            {renderSection('Platform administration', platformItems)}
          </>
        ) : isClientAdmin ? (
          <>
            {companySection.map(renderItem)}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT))}
              className={linkClass(false)}
            >
              <MessageCircleQuestion className="w-4 h-4 flex-shrink-0" />
              Help
            </button>
          </>
        ) : (
          employeeItems.map(renderItem)
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
            <p className="text-sidebar-foreground/40 text-xs truncate">
              {isSuperAdmin ? 'Platform admin' : isClientAdmin ? 'Company admin' : 'Member'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <NotificationBell />
            {isSuperAdmin && (
              <button
                onClick={onOpenHelp}
                className="flex items-center justify-center w-9 h-9 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                aria-label="Help"
                title="Help"
              >
                <MessageCircleQuestion className="w-4 h-4" />
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