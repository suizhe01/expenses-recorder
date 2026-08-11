/**
 * The React binding for the session manager. Deliberately thin: every rule
 * lives in session.ts, and this only subscribes a component tree to it.
 *
 * NG-9: context, not Redux. One value, one subscriber tree.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createClient } from '../api/client';
import { createAuthApi } from '../api/auth';
import { createSessionManager, type SessionManager, type SessionState } from './session';
import { createWebStorage } from './storage';

type SessionContextValue = {
  state: SessionState;
  session: SessionManager;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * AC-6. The base URL is the empty string, so every call is a relative path:
 * `/auth/login`, never an absolute origin.
 *
 * In production Fastify serves this app, so relative already means the right
 * host. In development Vite proxies the API prefixes. There is deliberately no
 * setting here — the native version had one and it was the single most
 * common way to end up talking to the wrong machine.
 */
export function createDefaultSessionManager(): SessionManager {
  const request = createClient('', (url, init) => fetch(url, init));

  return createSessionManager({
    auth: createAuthApi(request),
    storage: createWebStorage(),
  });
}

export function SessionProvider({
  children,
  manager,
}: {
  children: ReactNode;
  /** Injected by tests; production builds it from the environment. */
  manager?: SessionManager;
}) {
  // useState's lazy initialiser, not useMemo and not a ref: useMemo is a
  // performance hint React may discard and re-run, which would build a second
  // manager and lose the in-memory access token mid-session, and reading a ref
  // during render is exactly what the React lint rules forbid. A state
  // initialiser runs once and the value is stable for the component's life.
  const [session] = useState<SessionManager>(
    () => manager ?? createDefaultSessionManager(),
  );
  const [state, setState] = useState<SessionState>(() => session.getState());

  useEffect(() => {
    const unsubscribe = session.subscribe(setState);

    // AC-9. Restore starts once, on mount, before anything renders a screen.
    void session.restore();

    return unsubscribe;
  }, [session]);

  const value = useMemo(() => ({ state, session }), [state, session]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);

  if (value === null) {
    throw new Error('useSession must be used inside a SessionProvider');
  }

  return value;
}
