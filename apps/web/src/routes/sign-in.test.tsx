import { describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createClient } from '@/api/client';
import { createAuthApi } from '@/api/auth';
import { createSessionManager } from '@/session/session';
import { SessionProvider } from '@/session/context';
import { SIGN_IN_FAILED } from '@/api/messages';
import { SignInScreen } from '@/routes/sign-in';
import { fakeStorage, fakeTransport, session } from '@/test/support';

function mount(routes: Parameters<typeof fakeTransport>[0]) {
  const http = fakeTransport(routes);

  const manager = createSessionManager({
    auth: createAuthApi(createClient('', http.transport)),
    storage: fakeStorage(),
  });

  render(
    <SessionProvider manager={manager}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<SignInScreen />} />
          <Route path="/check-email" element={<p>Check email destination</p>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );

  return http;
}

async function signIn(password = 'correct-horse-battery') {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText('Email'), 'someone@example.com');
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('sign in (AC-5)', () => {
  it('submits what the API expects', async () => {
    const http = mount({ '/auth/login': { status: 200, body: session() } });

    await signIn();

    await waitFor(() => expect(http.countOf('/auth/login')).toBe(1));

    expect(JSON.parse(String(http.calls[0]!.init.body))).toEqual({
      email: 'someone@example.com',
      password: 'correct-horse-battery',
    });
  });

  /**
   * The API answers an identical 401 whether the address is unknown or the
   * password is wrong, so registration cannot be enumerated. The UI must not
   * undo that by guessing which half failed.
   *
   * Both cases are rendered and compared directly, rather than each being
   * checked against a constant — that way the test fails if they ever diverge,
   * whatever the wording becomes.
   */
  it('shows the same message for an unknown address and a wrong password', async () => {
    // The API sends a byte-identical 401 for both, but the bodies are varied
    // here anyway: if the screen ever started passing the server's message
    // through, these two would diverge and the comparison below would fail.
    async function messageFor(error: string): Promise<string | null> {
      mount({ '/auth/login': { status: 401, body: { error } } });
      await signIn('some-password-here');
      const alert = await screen.findByRole('alert');
      const text = alert.textContent;

      // Unmount properly between the two renders — removing the node by hand
      // leaves React holding a reference to something no longer in the tree.
      cleanup();

      return text;
    }

    const unknownAddress = await messageFor('Invalid email or password');
    const wrongPassword = await messageFor('Nope, wrong password');

    expect(unknownAddress).toBe(wrongPassword);
    expect(unknownAddress).toBe(SIGN_IN_FAILED);
  });

  it('counts down on 429 rather than showing a generic error', async () => {
    mount({
      '/auth/login': {
        status: 429,
        body: { error: 'Rate limit exceeded' },
        headers: { 'retry-after': '45' },
      },
    });

    await signIn();

    expect(
      await screen.findByText('Too many attempts. Try again in 45 seconds.'),
    ).toBeInTheDocument();
  });

  it('routes an unverified account to check-email', async () => {
    mount({
      '/auth/login': {
        status: 403,
        body: { error: 'Email not verified', code: 'EMAIL_NOT_VERIFIED' },
      },
    });

    await signIn();

    expect(await screen.findByText('Check email destination')).toBeInTheDocument();
  });

  it('reports being unable to reach the server distinctly from a rejection', async () => {
    const manager = createSessionManager({
      auth: createAuthApi(
        createClient('', async () => {
          throw new TypeError('Failed to fetch');
        }),
      ),
      storage: fakeStorage(),
    });

    render(
      <SessionProvider manager={manager}>
        <MemoryRouter>
          <SignInScreen />
        </MemoryRouter>
      </SessionProvider>,
    );

    await signIn();

    // "Check your connection" is a different action from "your password is
    // wrong", so collapsing the two would send the user down the wrong path.
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
  });
});
