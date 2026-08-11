import { useEffect, useState } from 'react';
import { useSession } from '../../src/session/context';
import { describeFailure } from '../../src/api/messages';
import { Body, Button, FormError, Screen, Title } from '../../src/ui/form';

/**
 * AC-13. A placeholder home, and the first real exercise of `authorized`:
 * `GET /auth/me` goes through the refresh-and-retry path, so an expired access
 * token is invisible here rather than being handled screen by screen.
 *
 * NG-4 — this is not the expense list. It exists to prove the session works
 * end to end and to give sign-out somewhere to live.
 */
export default function HomeScreen() {
  const { state, session } = useSession();
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Guards against resolving after the screen has gone — sign-out unmounts
    // this while /auth/me may still be in flight, and setting state then is a
    // warning at best and a leak at worst.
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

  // Falls back to the account the session already knows about, so the screen
  // has something to show before /auth/me answers.
  const known = state.status === 'signed-in' ? state.user.email : undefined;

  return (
    <Screen>
      <Title>Signed in</Title>
      <FormError message={error} />
      <Body>{email ?? known ?? 'Loading your account…'}</Body>
      <Body>
        Receipts, expenses and export are not built yet — this screen only
        proves the session works.
      </Body>

      <Button
        label="Sign out"
        variant="secondary"
        onPress={() => void session.signOut()}
      />
    </Screen>
  );
}
