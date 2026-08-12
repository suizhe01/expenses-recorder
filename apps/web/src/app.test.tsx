import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import { Routing } from '@/app';
import { SessionProvider } from '@/session/context';
import { createSessionManager, SESSION_ENDED } from '@/session/session';
import { fakeStorage, fakeTransport, session } from '@/test/support';

function mount(
  path: string,
  routes: Parameters<typeof fakeTransport>[0],
  storedRefreshToken: string | null,
) {
  const http = fakeTransport(routes);
  const manager = createSessionManager({
    auth: createAuthApi(createClient('', http.transport)),
    storage: fakeStorage(storedRefreshToken),
  });

  render(
    <SessionProvider manager={manager}>
      <MemoryRouter initialEntries={[path]}>
        <Routing />
      </MemoryRouter>
    </SessionProvider>,
  );

  return http;
}

describe('route guards (AC-6)', () => {
  it('redirects a signed-out visitor away from home', async () => {
    mount('/', {}, null);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();
  });

  it('redirects a signed-in visitor away from auth routes', async () => {
    const active = session();
    mount(
      '/sign-up',
      {
        '/auth/refresh': { status: 200, body: active },
        '/auth/me': { status: 200, body: active.user },
      },
      'stored-refresh',
    );

    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Create account' })).not.toBeInTheDocument();
  });
});

describe('session expiry (AC-7)', () => {
  it('returns to sign-in with a reason when a live session ends', async () => {
    const active = session();
    mount(
      '/',
      {
        '/auth/refresh': [
          { status: 200, body: active },
          { status: 401, body: { error: 'Invalid refresh token' } },
        ],
        '/auth/me': { status: 401, body: { error: 'Unauthorized' } },
      },
      'stored-refresh',
    );

    expect(await screen.findByText(SESSION_ENDED)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
