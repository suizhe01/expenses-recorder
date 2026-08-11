import { Redirect, Stack } from 'expo-router';
import { useSession } from '../../src/session/context';

/**
 * AC-14. The signed-out group, and the other half of the guard: a signed-in
 * user who reaches a sign-in URL is sent home rather than being offered a
 * second sign-in.
 *
 * This is also what stops the back gesture returning to a form after a
 * successful sign-in — the route may still be in history, but rendering it
 * redirects straight back out.
 */
export default function AuthLayout() {
  const { state } = useSession();

  if (state.status === 'signed-in') {
    return <Redirect href="/" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
