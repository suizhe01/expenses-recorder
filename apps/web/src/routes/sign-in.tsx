import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSession } from '@/session/context';
import { EMAIL_NOT_VERIFIED } from '@/api/auth';
import { describeFailure } from '@/api/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * AC-5. The one real screen in part A, proving the whole stack end to end:
 * build, same-origin serving, session, token rotation.
 *
 * No client-side password rule here on purpose. The length minimum belongs on
 * sign-up; rejecting a short password at sign-in would say something about
 * what is stored, and the server's answer is uniform precisely so nothing can
 * be inferred. Sign-up arrives in part B (NG-4).
 */
export function SignInScreen() {
  const { state, session } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Set when a refresh failed mid-session, so the user is told why they landed
  // back here rather than being dropped at a form with no explanation.
  const reason = state.status === 'signed-out' ? state.reason : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);

    const result = await session.signIn(email.trim(), password);

    setBusy(false);

    if (result.kind === 'ok') {
      // The guard moves the user; routing by hand here would fight it.
      return;
    }

    if (
      result.kind === 'error' &&
      result.status === 403 &&
      result.code === EMAIL_NOT_VERIFIED
    ) {
      navigate(`/check-email?email=${encodeURIComponent(email.trim())}`);
      return;
    }

    // signInSafe collapses every 401 to one message — see api/messages.ts.
    setError(describeFailure(result, { signInSafe: true }));
  }

  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-x-hidden p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Sign in
          </CardTitle>
          <CardDescription>Expenses Recorder</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={submit} className="grid gap-4" noValidate>
            {reason === undefined ? null : (
              <Alert>
                <AlertDescription>{reason}</AlertDescription>
              </Alert>
            )}

            {error === undefined ? null : (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="h-11"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-11"
              />
            </div>

            {/* h-11 keeps the tap target above the 44px minimum. */}
            <Button type="submit" disabled={busy} className="h-11 w-full">
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>

            <p className="text-muted-foreground text-center text-sm">
              No account?{' '}
              <Link
                to="/sign-up"
                className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4"
              >
                Create one
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
