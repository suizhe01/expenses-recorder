import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useSession } from '@/session/context';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const RESEND_CONFIRMATION =
  'If that address needs verifying, another email is on its way.';

/** AC-2. Every resend result gets the same confirmation to preserve enumeration safety. */
export function CheckEmailScreen() {
  const { session } = useSession();
  const [searchParams] = useSearchParams();
  const email = searchParams.get('email') ?? '';
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function resend() {
    setBusy(true);
    await session.auth.resendVerification(email);
    setBusy(false);
    setNotice(RESEND_CONFIRMATION);
  }

  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-x-hidden p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Check your email
          </CardTitle>
          <CardDescription>Verify your address before signing in</CardDescription>
        </CardHeader>

        <CardContent className="grid gap-4">
          <p className="text-sm leading-6 break-words">
            We sent a verification link to{' '}
            <span className="font-medium break-all">
              {email === '' ? 'your address' : email}
            </span>
            . Open it, then come back and sign in.
          </p>

          {notice === undefined ? null : (
            <Alert>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            className="h-11 w-full"
            onClick={() => void resend()}
          >
            {busy ? 'Resending…' : 'Resend email'}
          </Button>

          <Button asChild className="h-11 w-full">
            <Link to="/sign-in">I've verified — sign in</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
