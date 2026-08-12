import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { SessionProvider, useSession } from '@/session/context';
import { SignInScreen } from '@/routes/sign-in';
import { SignUpScreen } from '@/routes/sign-up';
import { CheckEmailScreen } from '@/routes/check-email';
import { HomeScreen } from '@/routes/home';
import { ConfirmReceiptScreen } from '@/routes/confirm-receipt';

/**
 * The route table plus the signed-in/signed-out split.
 *
 * AC-6. Every route goes through one signed-in/signed-out split. Authenticated
 * users cannot drift back into an auth form, and unauthenticated users never
 * render the private screen before being redirected.
 */
export function Routing() {
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
        path="/sign-up"
        element={signedIn ? <Navigate to="/" replace /> : <SignUpScreen />}
      />
      <Route
        path="/check-email"
        element={signedIn ? <Navigate to="/" replace /> : <CheckEmailScreen />}
      />
      <Route
        path="/"
        element={signedIn ? <HomeScreen /> : <Navigate to="/sign-in" replace />}
      />
      <Route path="/receipts/:id/confirm" element={signedIn ? <ConfirmReceiptScreen /> : <Navigate to="/sign-in" replace />} />
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
