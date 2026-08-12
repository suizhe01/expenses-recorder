import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import { useSession } from '@/session/context';
import { describeFailure } from '@/api/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const MIN_PASSWORD_LENGTH = 12;
const EMAIL_SCHEMA = z.string().email();

export function validateSignUp(
  email: string,
  password: string,
): Record<string, string> | undefined {
  const errors: Record<string, string> = {};

  // The API uses this same Zod email rule. Keeping the validator shared at the
  // library level prevents the browser accepting or rejecting a different set.
  if (!EMAIL_SCHEMA.safeParse(email).success) {
    errors.email = 'Enter a valid email address.';
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  return Object.keys(errors).length === 0 ? undefined : errors;
}

/** AC-1. Registration deliberately returns no session; success goes to email verification. */
export function SignUpScreen() {
  const { session } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);

    const trimmed = email.trim();
    const local = validateSignUp(trimmed, password);

    if (local !== undefined) {
      setFields(local);
      return;
    }

    setFields({});
    setBusy(true);
    const result = await session.auth.register(trimmed, password);
    setBusy(false);

    if (result.kind === 'ok') {
      navigate(`/check-email?email=${encodeURIComponent(trimmed)}`, {
        replace: true,
      });
      return;
    }

    if (
      result.kind === 'error' &&
      result.status === 400 &&
      result.fields !== undefined
    ) {
      setFields(result.fields);
      return;
    }

    setError(describeFailure(result));
  }

  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-x-hidden p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Create account
          </CardTitle>
          <CardDescription>Start your expense archive</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={submit} className="grid gap-4" noValidate>
            {error === undefined ? null : (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="h-11"
                aria-invalid={fields.email === undefined ? undefined : true}
                aria-describedby={
                  fields.email === undefined ? undefined : 'email-error'
                }
              />
              {fields.email === undefined ? null : (
                <p id="email-error" className="text-destructive text-sm">
                  {fields.email}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-11"
                aria-invalid={fields.password === undefined ? undefined : true}
                aria-describedby={
                  fields.password === undefined
                    ? 'password-hint'
                    : 'password-error password-hint'
                }
              />
              {fields.password === undefined ? null : (
                <p id="password-error" className="text-destructive text-sm">
                  {fields.password}
                </p>
              )}
              <p id="password-hint" className="text-muted-foreground text-sm">
                At least {MIN_PASSWORD_LENGTH} characters. Nothing else required.
              </p>
            </div>

            <Button type="submit" disabled={busy} className="h-11 w-full">
              {busy ? 'Creating account…' : 'Create account'}
            </Button>

            <p className="text-muted-foreground text-center text-sm">
              Already have an account?{' '}
              <Link
                to="/sign-in"
                className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4"
              >
                Sign in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
