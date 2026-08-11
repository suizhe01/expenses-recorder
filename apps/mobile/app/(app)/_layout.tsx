import { Redirect, Stack } from 'expo-router';
import { useSession } from '../../src/session/context';

/**
 * AC-14. The signed-in group. A user who is not signed in never renders
 * anything inside it — the redirect happens before the child screen mounts, so
 * a protected screen cannot flash its contents or fire its data request.
 */
export default function AppLayout() {
  const { state } = useSession();

  if (state.status !== 'signed-in') {
    return <Redirect href="/sign-in" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
