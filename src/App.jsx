import { useEffect } from 'react'
import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "@/components/ui/sonner"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';

// Public, MindVault-branded routes that must render WITHOUT the auth gate —
// an invitee / password-reset user has no session yet and must be able to
// choose Google / Microsoft / email+password here.
import AcceptInvite from './pages/AcceptInvite';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';

const PUBLIC_PATHS = ['/invite/accept', '/forgot-password', '/reset-password'];
const isPublicPath = (p) => PUBLIC_PATHS.some((x) => p === x || p.startsWith(`${x}/`));

// Layout
import AppLayout from './components/layout/AppLayout';

// Pages
import Home from './pages/Home';
import Library from './pages/Library';
import Chat from './pages/Chat';
import MyQuestions from './pages/MyQuestions';
import Continuity from './pages/Continuity';
import Admin from './pages/Admin';
import TrainingDetail from './pages/TrainingDetail';
import Roadmap from './pages/Roadmap';
import TeamMembers from './pages/TeamMembers';
import GettingStarted from './pages/GettingStarted';
import Manage from './pages/Manage';
import Processes from './pages/Processes';
import About from './pages/About';
import Contact from './pages/Contact';

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const { pathname } = useLocation();

  // Public branded pages bypass the auth gate entirely — no spinner wait, no
  // redirect to the Base44 login, no "not registered" screen.
  if (isPublicPath(pathname)) {
    return (
      <Routes>
        <Route path="/invite/accept" element={<AcceptInvite />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<PageNotFound />} />
      </Routes>
    );
  }

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-muted border-t-primary rounded-full animate-spin"></div>
      </div>
    );
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      navigateToLogin();
      return null;
    }
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/library" element={<Library />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/my-questions" element={<MyQuestions />} />
        <Route path="/continuity" element={<Continuity />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/training/:id" element={<TrainingDetail />} />
        <Route path="/roadmap" element={<Roadmap />} />
        <Route path="/team" element={<TeamMembers />} />
        <Route path="/setup" element={<GettingStarted />} />
        <Route path="/manage" element={<Manage />} />
        <Route path="/processes" element={<Processes />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Contact />} />
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function App() {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => document.documentElement.classList.toggle('dark', mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <AuthenticatedApp />
        </Router>
        <Toaster />
        <SonnerToaster position="bottom-right" />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App