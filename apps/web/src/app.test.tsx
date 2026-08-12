import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import { Routing } from '@/app';
import { SessionProvider } from '@/session/context';
import { createSessionManager, SESSION_ENDED } from '@/session/session';
import { fakeStorage, fakeTransport, session } from '@/test/support';
import { CLIENT_ROUTES, confirmReceiptPath } from '@/client-routes';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

    expect(await screen.findByRole('heading', { name: 'Receipts' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Create account' })).not.toBeInTheDocument();
  });
});

describe('direct loads of the moved routes (EXP-37 AC-3, AC-8)', () => {
  it('renders the confirm screen from its own URL', async () => {
    const receipt = {
      id: 'receipt-1', contentType: 'image/jpeg', byteSize: 4, originalFilename: 'lunch.jpg',
      createdAt: '2026-08-12T00:00:00.000Z', expenseId: null, extraction: null,
    };
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      if (path === '/receipts') return new Response(JSON.stringify([receipt]), { status: 200 });
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const active = session();
    mount(
      confirmReceiptPath('receipt-1'),
      {
        '/auth/refresh': { status: 200, body: active },
        '/auth/me': { status: 200, body: active.user },
      },
      'stored-refresh',
    );

    expect(await screen.findByRole('heading', { name: 'Confirm receipt' })).toBeInTheDocument();
  });

  it('renders the expense list from a filtered URL', async () => {
    const active = session();
    mount(
      `${CLIENT_ROUTES.expenses}?from=2026-08-01&hasReceipt=true`,
      {
        '/auth/refresh': { status: 200, body: active },
        '/auth/me': { status: 200, body: active.user },
      },
      'stored-refresh',
    );

    expect(await screen.findByRole('heading', { name: 'Expenses' })).toBeInTheDocument();
  });
});

describe('session expiry (AC-7)', () => {
  it('returns to sign-in with a reason when a live session ends', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));
    const active = session();
    mount(
      '/',
      {
        '/auth/refresh': [
          { status: 200, body: active },
          { status: 401, body: { error: 'Invalid refresh token' } },
        ],
      },
      'stored-refresh',
    );

    expect(await screen.findByText(SESSION_ENDED)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
