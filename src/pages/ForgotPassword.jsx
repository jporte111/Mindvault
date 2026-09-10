import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { KeyRound, Loader2 } from 'lucide-react';
import AuthLayout from '@/components/AuthLayout';
import { resetRequestResult } from '@/lib/passwordResetMessages';

// MindVault-branded "forgot password". Calls Base44's supported
// resetPasswordRequest. The screen is branded; the email itself is still sent
// by Base44 (the platform has no from-address / template override).
//
// It NEVER shows "email sent" unless the request actually resolved, and the
// success copy is account-enumeration-neutral (identical for a known and an
// unknown address).

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { tone, message, retryable }

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      await base44.auth.resetPasswordRequest(email.trim());
      setResult(resetRequestResult({ resolved: true }));
    } catch (err) {
      const status = err?.response?.status || err?.status;
      setResult(resetRequestResult({ resolved: false, status }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout icon={KeyRound} title="Reset your password" subtitle="MindVault">
      {result && result.tone === 'neutral' ? (
        <div className="text-center">
          <p className="text-sm text-foreground">{result.message}</p>
          <p className="text-xs text-muted-foreground mt-3">
            Signed up with Google or Microsoft? There’s no password to reset — use that button on the
            sign-in screen.
          </p>
          <Button asChild variant="outline" className="mt-6">
            <a href="/">Back to MindVault</a>
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter your email and we’ll send a link to set a new password.
          </p>
          {result && result.tone === 'error' ? (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {result.message}
            </div>
          ) : null}
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
          <Button type="submit" className="w-full h-11" disabled={busy || !email.trim()}>
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Send reset link
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Signed up with Google or Microsoft? Use that button on the sign-in screen instead.
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
