import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { SessionProvider, useSession } from '@/session/context';
import { SignInScreen } from '@/routes/sign-in';
import { HomeScreen } from '@/routes/home';

/**
 * The route table plus the signed-in/signed-out split.
 *
 * Part A keeps this deliberately small — two routes. The full guard treatment,
 * with tests in both directions, is AC-6 of part B, which is where the gap
 * EXP-24 left open gets closed.
 */
function Routing() {
  const { state } = useSession();

  if (state.status === 'restoring') {
    // Nothing routable renders while the stored token is being rotated:
    // showing sign-in first and correcting a moment later is a visible flash
    // of the wrong screen.
    return (
      <main
        className="text-muted-foreground flex min-h-dvh items-center justify-center"
        aria-busy="true"
      >
        Loading…
      </main>
    );
  }

  const signedIn = state.status === 'signed-in';

  return (
    <Routes>
      <Route
        path="/sign-in"
        element={signedIn ? <Navigate to="/" replace /> : <SignInScreen />}
      />
      <Route
        path="/"
        element={signedIn ? <HomeScreen /> : <Navigate to="/sign-in" replace />}
      />
      <Route path="*" element={<Navigate to={signedIn ? '/' : '/sign-in'} replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routing />
      </BrowserRouter>
    </SessionProvider>
  );
}
