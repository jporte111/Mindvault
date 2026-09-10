import { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, MailCheck, ShieldCheck } from 'lucide-react';
import { previewState, acceptErrorMessage, roleDescription } from '@/lib/inviteMessages';

// The MindVault-branded accept-invite screen. Public (renders outside the
// auth gate). It never trusts anything from the URL beyond the opaque token:
// the tenant, the role, and the email binding all come from the server.
//
//   1. getInvitePreview(token)  -> branded company card + assigned role
//   2. authenticate             -> Google / Microsoft (primary) or email+password
//   3. acceptTenantInvite(token)-> server matches the authed email, activates
//      the membership, and we land the user inside their workspace

const brandStyle = (hex) =>
  /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(String(hex || '').trim())
    ? { backgroundColor: hex.trim() }
    : undefined;

function Shell({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-primary mb-3">
            <ShieldCheck className="w-6 h-6 text-primary-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm font-semibold tracking-tight text-primary">MindVault</p>
        </div>
        <div className="bg-card rounded-2xl shadow-sm border border-border p-8">{children}</div>
        <p className="text-center text-xs text-muted-foreground mt-6">
          Powered by MindVault. If you weren’t expecting this invitation, you can close this page.
        </p>
      </div>
    </div>
  );
}

export default function AcceptInvite() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('token') || '', []);
  const fromUrl = `${window.location.pathname}${window.location.search}`;

  const [phase, setPhase] = useState('loading'); // loading | invalid | ready | accepting | accepted | error
  const [invalid, setInvalid] = useState(null);
  const [preview, setPreview] = useState(null);
  const [sessionEmail, setSessionEmail] = useState(null);
  const [error, setError] = useState('');

  // email/password fallback
  const [mode, setMode] = useState('signin'); // signin | create | otp
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setInvalid(previewState({ valid: false, reason: 'not_found' }));
        setPhase('invalid');
        return;
      }
      // Is there already a session (e.g. we just came back from OAuth)?
      try {
        const me = await base44.auth.me();
        if (!cancelled && me?.email) setSessionEmail(me.email);
      } catch {
        /* not signed in — expected */
      }
      try {
        const res = await base44.functions.invoke('getInvitePreview', { token });
        const data = res?.data ?? res;
        if (cancelled) return;
        const state = previewState(data);
        if (state.kind === 'ready') {
          setPreview(data);
          setPhase('ready');
        } else {
          setInvalid(state);
          setPhase('invalid');
        }
      } catch {
        if (cancelled) return;
        setInvalid(previewState({ valid: false, reason: 'error' }));
        setPhase('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const doAccept = async () => {
    setError('');
    setPhase('accepting');
    try {
      const res = await base44.functions.invoke('acceptTenantInvite', { token });
      const data = res?.data ?? res;
      if (data?.accepted) {
        setPhase('accepted');
        // Full reload so AuthContext + membership hooks re-resolve cleanly.
        setTimeout(() => {
          window.location.href = '/';
        }, 1200);
        return;
      }
      setError(acceptErrorMessage(data?.reason));
      setPhase('ready');
    } catch (e) {
      const reason = e?.response?.data?.reason || e?.data?.reason;
      setError(acceptErrorMessage(reason || 'error'));
      setPhase('ready');
    }
  };

  const oauth = (provider) => {
    try {
      base44.auth.loginWithProvider(provider, fromUrl);
    } catch (e) {
      setError('Could not start sign-in. Please try the email option below.');
    }
  };

  const signInWithPassword = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await base44.auth.loginViaEmailPassword(email.trim(), password);
      setSessionEmail(email.trim());
      await doAccept();
    } catch (err) {
      setError(
        err?.response?.status === 401 || /invalid|not registered/i.test(err?.message || '')
          ? 'That email and password didn’t match. If you’re new, choose “Create your account”.'
          : 'Could not sign in. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const createAccount = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await base44.auth.register({ email: email.trim(), password });
      setMode('otp');
    } catch (err) {
      setError(
        /already|exists|registered/i.test(err?.message || '')
          ? 'An account with that email already exists. Use “Sign in” instead.'
          : 'Could not create the account. Check the email and password and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const verifyAndAccept = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await base44.auth.verifyOtp({ email: email.trim(), otpCode: otp.trim() });
      // Get a clean session token, then accept.
      await base44.auth.loginViaEmailPassword(email.trim(), password);
      setSessionEmail(email.trim());
      await doAccept();
    } catch (err) {
      setError('That code didn’t work. Check your email for the latest code and try again.');
    } finally {
      setBusy(false);
    }
  };

  // ---- render ----

  if (phase === 'loading') {
    return (
      <Shell>
        <div className="flex items-center justify-center py-6 text-muted-foreground">
          <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading your invitation…
        </div>
      </Shell>
    );
  }

  if (phase === 'invalid') {
    return (
      <Shell>
        <div className="text-center">
          <h1 className="text-xl font-bold text-foreground">{invalid?.title}</h1>
          <p className="text-sm text-muted-foreground mt-2">{invalid?.body}</p>
          <Button asChild variant="outline" className="mt-6">
            <a href="/">Go to MindVault</a>
          </Button>
        </div>
      </Shell>
    );
  }

  if (phase === 'accepted') {
    return (
      <Shell>
        <div className="text-center py-2">
          <MailCheck className="w-8 h-8 text-primary mx-auto mb-3" />
          <h1 className="text-xl font-bold text-foreground">You’re in</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Taking you to {preview?.tenantName || 'your workspace'}…
          </p>
        </div>
      </Shell>
    );
  }

  const company = preview?.tenantName || 'your company';
  const roleLabel = preview?.roleLabel || 'team member';

  return (
    <Shell>
      <div className="text-center">
        {preview?.tenantLogoUrl ? (
          <img
            src={preview.tenantLogoUrl}
            alt={company}
            className="h-10 max-h-10 mx-auto mb-3 object-contain"
          />
        ) : null}
        <h1 className="text-xl font-bold text-foreground leading-snug">
          You’ve been invited to join
          <br />
          {company}’s MindVault
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          Your role: <span className="font-medium text-foreground">{roleLabel}</span>
        </p>
        <p className="text-xs text-muted-foreground mt-1">{roleDescription(roleLabel)}</p>
        {preview?.emailMasked ? (
          <p className="text-xs text-muted-foreground mt-3">
            Invitation sent to <span className="font-mono">{preview.emailMasked}</span> — sign in with
            that address.
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="mt-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      ) : null}

      {sessionEmail ? (
        <div className="mt-6 space-y-3">
          <Button
            className="w-full h-11"
            style={brandStyle(preview?.brandColor)}
            disabled={phase === 'accepting'}
            onClick={doAccept}
          >
            {phase === 'accepting' ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            Join MindVault as {sessionEmail}
          </Button>
          <button
            type="button"
            className="w-full text-xs text-muted-foreground hover:text-foreground"
            onClick={() => base44.auth.logout(fromUrl)}
          >
            Not you? Sign out and use a different account
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          <Button
            variant="outline"
            className="w-full h-11 font-medium"
            onClick={() => oauth('google')}
          >
            Continue with Google
          </Button>
          <Button
            variant="outline"
            className="w-full h-11 font-medium"
            onClick={() => oauth('microsoft')}
          >
            Continue with Microsoft
          </Button>

          <details className="pt-2">
            <summary className="text-xs text-muted-foreground cursor-pointer text-center list-none">
              Or use an email and password
            </summary>

            <div className="mt-4">
              <div className="flex text-xs mb-3 rounded-lg border border-border overflow-hidden">
                <button
                  type="button"
                  className={`flex-1 py-2 ${mode !== 'create' ? 'bg-muted font-medium' : ''}`}
                  onClick={() => setMode('signin')}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className={`flex-1 py-2 ${mode === 'create' ? 'bg-muted font-medium' : ''}`}
                  onClick={() => setMode('create')}
                >
                  Create your account
                </button>
              </div>

              {mode === 'otp' ? (
                <form onSubmit={verifyAndAccept} className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    We emailed a verification code to {email.trim() || 'your address'}. Enter it to
                    finish.
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="otp" className="text-sm">
                      Verification code
                    </Label>
                    <Input
                      id="otp"
                      value={otp}
                      onChange={(e) => setOtp(e.target.value)}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                    />
                  </div>
                  <Button type="submit" className="w-full h-11" disabled={busy || !otp.trim()}>
                    {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Verify and join
                  </Button>
                  <button
                    type="button"
                    className="w-full text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => base44.auth.resendOtp(email.trim()).catch(() => {})}
                  >
                    Resend code
                  </button>
                </form>
              ) : (
                <form
                  onSubmit={mode === 'create' ? createAccount : signInWithPassword}
                  className="space-y-3"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="email" className="text-sm">
                      Email
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      placeholder="you@company.com"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="password" className="text-sm">
                      Password
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                      placeholder="••••••••"
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full h-11"
                    disabled={busy || !email.trim() || !password}
                  >
                    {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    {mode === 'create' ? 'Create account' : 'Sign in and join'}
                  </Button>
                  {mode === 'create' ? (
                    <p className="text-[11px] text-muted-foreground text-center">
                      You’ll get a one-time verification code by email to confirm your address.
                    </p>
                  ) : null}
                </form>
              )}
            </div>
          </details>

          <p className="text-[11px] text-muted-foreground text-center pt-1">
            This invitation expires soon. Accepting activates your access to {company}’s workspace
            only.
          </p>
        </div>
      )}
    </Shell>
  );
}
