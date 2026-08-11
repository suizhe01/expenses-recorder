import { Stack } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SessionProvider, useSession } from '../src/session/context';

/**
 * AC-9. The splash. While the stored refresh token is being rotated we know
 * neither destination, so nothing routable is rendered — showing sign-in first
 * and correcting a moment later is the "flash of the wrong screen" the
 * criterion rules out.
 */
function Gate() {
  const { state } = useSession();

  if (state.status === 'restoring') {
    return (
      <View style={styles.splash} testID="splash">
        <ActivityIndicator size="large" />
        <Text style={styles.splashText}>Expenses Recorder</Text>
      </View>
    );
  }

  // AC-14. Both groups are declared; each group's own layout redirects when it
  // is the wrong one for the current state. Declaring only the matching group
  // would work too, but it unmounts the whole navigator on every sign-in and
  // sign-out, which loses the animation and flickers.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(app)" />
      <Stack.Screen name="(auth)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    backgroundColor: '#fff',
  },
  splashText: { fontSize: 16, color: '#555' },
});
