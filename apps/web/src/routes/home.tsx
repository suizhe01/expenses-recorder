import { useEffect, useState } from 'react';
import { useSession } from '@/session/context';
import { describeFailure } from '@/api/messages';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * AC-5. The signed-in placeholder, and the first real exercise of
 * `authorized`: `GET /auth/me` goes through the refresh-and-retry path, so an
 * expired access token is invisible here rather than handled screen by screen.
 *
 * NG-6 — this is not the expense list. It exists to prove the session works
 * end to end and to give sign-out somewhere to live.
 */
export function HomeScreen() {
  const { state, session } = useSession();
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Guards against resolving after the screen has gone: signing out unmounts
    // this while /auth/me may still be in flight.
    let cancelled = false;

    void (async () => {
      const result = await session.authorized((token) => session.auth.me(token));

      if (cancelled) {
        return;
      }

      if (result.kind === 'ok') {
        setEmail(result.body.email);
        setError(undefined);
        return;
      }

      // A 401 that survived the retry has already signed the user out and the
      // guard is redirecting; an error underneath would flash on the way past.
      if (result.kind === 'error' && result.status === 401) {
        return;
      }

      setError(describeFailure(result));
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  // Falls back to what the session already knows, so the screen has something
  // to show before /auth/me answers.
  const known = state.status === 'signed-in' ? state.user.email : undefined;

  return (
    <main className="flex min-h-dvh items-start justify-center p-4">
      <Card className="mt-8 w-full max-w-sm">
        <CardHeader>
          <CardTitle>Signed in</CardTitle>
        </CardHeader>

        <CardContent className="grid gap-4">
          {error === undefined ? null : (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <p className="text-sm break-all">{email ?? known ?? 'Loading…'}</p>

          <p className="text-muted-foreground text-sm">
            Receipts, expenses and export are not built yet — this screen only
            proves the session works.
          </p>

          <Button
            variant="outline"
            className="h-11 w-full"
            onClick={() => void session.signOut()}
          >
            Sign out
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
