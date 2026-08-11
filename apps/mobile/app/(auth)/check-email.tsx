import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useSession } from '../../src/session/context';
import { Body, Button, Notice, Screen, Title } from '../../src/ui/form';

/**
 * AC-12. Where both signup and an unverified sign-in land.
 *
 * The resend confirmation is FIXED. `/auth/resend-verification` answers the
 * same 202 whether the address is unknown, already verified, or throttled,
 * because any variation makes it an account-enumeration oracle. Rendering the
 * server's outcome — or even distinguishing success from failure — would
 * rebuild that oracle in the client, so this shows one sentence and ignores
 * everything but a total inability to reach the server.
 *
 * NG-2: no deep link. The verification link opens a server-rendered page in
 * the browser, which cannot hand control back to the app, so the user returns
 * here themselves and taps through.
 */
export const RESEND_CONFIRMATION =
  'If that address needs verifying, another email is on its way.';

export default function CheckEmailScreen() {
  const { session } = useSession();
  const params = useLocalSearchParams<{ email?: string }>();
  const email = typeof params.email === 'string' ? params.email : '';

  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function resend() {
    setBusy(true);

    const result = await session.auth.resendVerification(email);

    setBusy(false);

    // Only a failure to reach the server at all is reported differently — that
    // is about the network, not about the account, so it leaks nothing.
    setNotice(
      result.kind === 'offline' ? result.message : RESEND_CONFIRMATION,
    );
  }

  return (
    <Screen>
      <Title>Check your email</Title>
      <Body>
        We sent a verification link to {email === '' ? 'your address' : email}.
        Open it, then come back and sign in.
      </Body>

      <Notice message={notice} />

      <Button
        label="Resend email"
        variant="secondary"
        onPress={() => void resend()}
        busy={busy}
      />
      <Button
        label="I've verified — sign in"
        onPress={() => router.replace('/sign-in')}
      />
    </Screen>
  );
}
