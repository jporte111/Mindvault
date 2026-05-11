import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

export default function AppLayout() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    base44.auth.me().then(setUser).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-background flex">
      <Sidebar user={user} />
      <main className="flex-1 ml-64 min-h-screen">
        <Outlet context={{ user }} />
      </main>
    </div>
  );
}