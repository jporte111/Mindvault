import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import Sidebar from './Sidebar';
import MobileNav from './MobileNav';
import Footer from './Footer';
import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { useIsMobile } from '@/hooks/use-mobile';
import GuidedTour from '@/components/onboarding/GuidedTour';
import AdminHelpAssistant from '@/components/onboarding/AdminHelpAssistant';

export default function AppLayout() {
  const [user, setUser] = useState(null);
  const location = useLocation();
  const isMobile = useIsMobile();
  const guidedTourRef = useRef(null);
  const openHelp = () => guidedTourRef.current?.restart();

  useEffect(() => {
    base44.auth.me().then(setUser).catch(() => {});
  }, []);

  const slide = isMobile ? 30 : 0;

  return (
    <div className="min-h-screen bg-background">
      <Sidebar user={user} onOpenHelp={openHelp} />
      <MobileNav user={user} onOpenHelp={openHelp} />
      <main className="flex-1 md:ml-64 min-h-screen pt-[calc(3.5rem+env(safe-area-inset-top))] md:pt-0 pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, x: slide }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -slide }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <Outlet context={{ user }} />
          </motion.div>
        </AnimatePresence>
        <Footer />
      </main>
      {/* Guided Product Tour — mounted once at layout level so it survives
          route changes and can be restarted from the Help trigger in either
          nav. Renders nothing itself; driver.js portals its own overlay. */}
      <GuidedTour ref={guidedTourRef} />
      {/* Admin Help Assistant — ongoing conversational product support,
          separate from the guided tour and from the employee AI Assistant.
          Self-guards admin-only; renders its own floating launcher. */}
      <AdminHelpAssistant />
    </div>
  );
}