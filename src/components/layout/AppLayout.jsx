import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import Sidebar from './Sidebar';
import MobileNav from './MobileNav';
import Footer from './Footer';
import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useIsMobile } from '@/hooks/use-mobile';

export default function AppLayout() {
  const [user, setUser] = useState(null);
  const location = useLocation();
  const isMobile = useIsMobile();

  useEffect(() => {
    base44.auth.me().then(setUser).catch(() => {});
  }, []);

  const slide = isMobile ? 30 : 0;

  return (
    <div className="min-h-screen bg-background">
      <Sidebar user={user} />
      <MobileNav user={user} />
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
    </div>
  );
}