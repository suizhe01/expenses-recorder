import { useState } from 'react';
import { Link, router } from 'expo-router';
import { View } from 'react-native';
import { useSession } from '../../src/session/context';
import { EMAIL_NOT_VERIFIED } from '../../src/api/auth';
import { describeFailure } from '../../src/api/messages';
import { Body, Button, Field, FormError, Notice, Screen, Title } from '../../src/ui/form';

/**
 * AC-11. Three outcomes, three destinations.
 *
 * There is deliberately no client-side password validation here. The rules
 * belong on sign-up; on sign-in, rejecting a password locally for being short
 * would tell the user something about what is stored, and the server's answer
 * is uniform precisely so nothing can be inferred.
 */
export default function SignInScreen() {
  const { state, session } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // AC-6. Set when a refresh failed mid-session, so the user is told why they
  // were returned here rather than being dropped at a form with no explanation.
  const reason = state.status === 'signed-out' ? state.reason : undefined;

  async function submit() {
    setError(undefined);
    setBusy(true);

    const result = await session.signIn(email.trim(), password);

    setBusy(false);

    if (result.kind === 'ok') {
      // The group guard sends them home; nothing to do here.
      return;
    }

    if (
      result.kind === 'error' &&
      result.status === 403 &&
      result.code === EMAIL_NOT_VERIFIED
    ) {
      router.push({
        pathname: '/check-email',
        params: { email: email.trim() },
      });
      return;
    }

    // signInSafe collapses every 401 to one message — see messages.ts.
    setError(describeFailure(result, { signInSafe: true }));
  }

  return (
    <Screen>
      <Title>Sign in</Title>
      <Notice message={reason} />
      <FormError message={error} />

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        textContentType="emailAddress"
        placeholder="you@example.com"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="password"
      />

      <Button label="Sign in" onPress={() => void submit()} busy={busy} />

      <View>
        <Body>
          No account? <Link href="/sign-up">Create one</Link>
        </Body>
      </View>
    </Screen>
  );
}
