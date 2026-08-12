import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import { SignUpScreen } from '@/routes/sign-up';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, fakeTransport } from '@/test/support';

function mount(routes: Parameters<typeof fakeTransport>[0]) {
  const http = fakeTransport(routes);
  const manager = createSessionManager({
    auth: createAuthApi(createClient('', http.transport)),
    storage: fakeStorage(),
  });

  render(
    <SessionProvider manager={manager}>
      <MemoryRouter initialEntries={['/sign-up']}>
        <Routes>
          <Route path="/sign-up" element={<SignUpScreen />} />
          <Route path="/check-email" element={<p>Check email for someone@example.com</p>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );

  return http;
}

async function fill(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('sign up (AC-1)', () => {
  it('rejects invalid fields without sending a request', async () => {
    const http = mount({
      '/auth/register': { status: 201, body: { message: 'Check your email' } },
    });

    await fill('not-an-email', 'a'.repeat(11));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Must be at least 12 characters.')).toBeInTheDocument();
    expect(http.countOf('/auth/register')).toBe(0);
  });

  it('registers, never signs in, and routes to check-email on 201', async () => {
    const http = mount({
      '/auth/register': { status: 201, body: { message: 'Check your email' } },
    });

    await fill(' someone@example.com ', 'correct-horse-battery');

    expect(await screen.findByText('Check email for someone@example.com')).toBeInTheDocument();
    expect(http.countOf('/auth/register')).toBe(1);
    expect(http.countOf('/auth/login')).toBe(0);
    expect(JSON.parse(String(http.calls[0]!.init.body))).toEqual({
      email: 'someone@example.com',
      password: 'correct-horse-battery',
    });
  });

  it('renders the API field messages from a 400', async () => {
    mount({
      '/auth/register': {
        status: 400,
        body: {
          error: 'Validation failed',
          fields: {
            email: 'must be a valid email address',
            password: 'must be at least 12 characters',
          },
        },
      },
    });

    await fill('someone@example.com', 'correct-horse-battery');

    await waitFor(() => {
      expect(screen.getByText('must be a valid email address')).toBeInTheDocument();
      expect(screen.getByText('must be at least 12 characters')).toBeInTheDocument();
    });
  });
});
