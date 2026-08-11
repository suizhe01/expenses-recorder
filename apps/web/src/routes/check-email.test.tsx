import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import {
  CheckEmailScreen,
  RESEND_CONFIRMATION,
} from '@/routes/check-email';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, fakeTransport, type Reply } from '@/test/support';

function mount(reply?: Reply) {
  const http = fakeTransport(
    reply === undefined ? {} : { '/auth/resend-verification': reply },
  );
  const manager = createSessionManager({
    auth: createAuthApi(createClient('', http.transport)),
    storage: fakeStorage(),
  });

  render(
    <SessionProvider manager={manager}>
      <MemoryRouter initialEntries={['/check-email?email=someone%40example.com']}>
        <Routes>
          <Route path="/check-email" element={<CheckEmailScreen />} />
          <Route path="/sign-in" element={<p>Sign in destination</p>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );

  return http;
}

describe('check email (AC-2)', () => {
  it('shows the address passed by sign-up or sign-in', () => {
    mount();
    expect(screen.getByText('someone@example.com')).toBeInTheDocument();
  });

  it.each([
    ['202', { status: 202, body: { message: 'Verification email sent' } }],
    ['429', { status: 429, body: { error: 'Rate limit exceeded' } }],
    ['500', { status: 500, body: { error: 'Internal Server Error' } }],
  ] satisfies [string, Reply][])('shows one fixed confirmation for %s', async (_label, reply) => {
    mount(reply);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Resend email' }));

    expect(await screen.findByText(RESEND_CONFIRMATION)).toBeInTheDocument();
  });

  it('returns to sign-in after verification', async () => {
    mount();
    const user = userEvent.setup();

    await user.click(screen.getByRole('link', { name: "I've verified — sign in" }));

    expect(await screen.findByText('Sign in destination')).toBeInTheDocument();
  });
});
