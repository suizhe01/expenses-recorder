import { useState } from 'react';
import { Link, router } from 'expo-router';
import { View } from 'react-native';
import { useSession } from '../../src/session/context';
import { describeFailure } from '../../src/api/messages';
import { Body, Button, Field, FormError, Screen, Title } from '../../src/ui/form';

/**
 * AC-10. The rules mirror the API's zod schema exactly: a valid email and a
 * password of at least 12 characters, with NO composition rules — no digit, no
 * symbol, no mixed case. That is a deliberate choice on the server (current
 * NIST guidance), and a client that demands a symbol would reimpose what the
 * API dropped.
 *
 * Registration returns a message and nothing else — no tokens, no user — so
 * there is nothing to sign in with. The only correct next step is the
 * check-email screen.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function validate(
  email: string,
  password: string,
): Record<string, string> | undefined {
  const errors: Record<string, string> = {};

  // Intentionally permissive: the server's validator is authoritative, and a
  // stricter regex here would reject addresses the API would have accepted.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    errors.email = 'Enter a valid email address.';
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  return Object.keys(errors).length === 0 ? undefined : errors;
}

export default function SignUpScreen() {
  const { session } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(undefined);

    const trimmed = email.trim();
    const local = validate(trimmed, password);

    if (local !== undefined) {
      // No request is sent. Round-tripping a password we already know is too
      // short spends one of the ten requests a minute the API allows.
      setFields(local);
      return;
    }

    setFields({});
    setBusy(true);

    const result = await session.auth.register(trimmed, password);

    setBusy(false);

    if (result.kind === 'ok') {
      router.replace({ pathname: '/check-email', params: { email: trimmed } });
      return;
    }

    if (result.kind === 'error' && result.fields !== undefined) {
      setFields(result.fields);
      return;
    }

    setError(describeFailure(result));
  }

  return (
    <Screen>
      <Title>Create account</Title>
      <FormError message={error} />

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        textContentType="emailAddress"
        placeholder="you@example.com"
        error={fields.email}
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="newPassword"
        error={fields.password}
      />
      <Body>At least {MIN_PASSWORD_LENGTH} characters. Nothing else required.</Body>

      <Button label="Create account" onPress={() => void submit()} busy={busy} />

      <View>
        <Body>
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </Body>
      </View>
    </Screen>
  );
}
