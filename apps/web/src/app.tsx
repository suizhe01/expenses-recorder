import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { SessionProvider, useSession } from '@/session/context';
import { SignInScreen } from '@/routes/sign-in';
import { SignUpScreen } from '@/routes/sign-up';
import { CheckEmailScreen } from '@/routes/check-email';
import { OverviewScreen } from '@/routes/overview';
import { ConfirmReceiptScreen } from '@/routes/confirm-receipt';
import { ExpensesScreen } from '@/routes/expenses';
import { CLIENT_ROUTES } from '@/client-routes';
import { ExpenseDetailScreen } from '@/routes/expense-detail';

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
        path={CLIENT_ROUTES.signIn}
        element={signedIn ? <Navigate to={CLIENT_ROUTES.home} replace /> : <SignInScreen />}
      />
      <Route path={CLIENT_ROUTES.expenses} element={signedIn ? <ExpensesScreen /> : <Navigate to={CLIENT_ROUTES.signIn} replace />} />
      <Route path={CLIENT_ROUTES.expenses} element={signedIn ? <ExpensesScreen /> : <Navigate to={CLIENT_ROUTES.signIn} replace />} />
      <Route path={CLIENT_ROUTES.expenseDetail} element={signedIn ? <ExpenseDetailScreen /> : <Navigate to={CLIENT_ROUTES.signIn} replace />} />
      <Route
        path={CLIENT_ROUTES.signUp}
        element={signedIn ? <Navigate to={CLIENT_ROUTES.home} replace /> : <SignUpScreen />}
      />
      <Route
        path={CLIENT_ROUTES.checkEmail}
        element={signedIn ? <Navigate to={CLIENT_ROUTES.home} replace /> : <CheckEmailScreen />}
      />
      <Route
        path={CLIENT_ROUTES.home}
        element={signedIn ? <OverviewScreen /> : <Navigate to={CLIENT_ROUTES.signIn} replace />}
      />
      <Route path={CLIENT_ROUTES.confirmReceipt} element={signedIn ? <ConfirmReceiptScreen /> : <Navigate to={CLIENT_ROUTES.signIn} replace />} />
      <Route path={CLIENT_ROUTES.catchAll} element={<Navigate to={signedIn ? CLIENT_ROUTES.home : CLIENT_ROUTES.signIn} replace />} />
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
