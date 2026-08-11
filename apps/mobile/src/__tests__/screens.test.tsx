import { render, screen, userEvent, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { createClient } from '../api/client';
import { createAuthApi } from '../api/auth';
import { createSessionManager } from '../session/session';
import { SessionProvider } from '../session/context';
import { SIGN_IN_FAILED } from '../api/messages';
import { fakeStorage, fakeTransport, session } from './support';
import SignInScreen from '../../app/(auth)/sign-in';
import SignUpScreen from '../../app/(auth)/sign-up';
import CheckEmailScreen, { RESEND_CONFIRMATION } from '../../app/(auth)/check-email';

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => {
  const { Text } = require('react-native');

  return {
    router: {
      push: (...args: unknown[]) => mockPush(...args),
      replace: (...args: unknown[]) => mockReplace(...args),
    },
    useLocalSearchParams: () => mockParams,
    Link: ({ children }: { children: React.ReactNode }) => <Text>{children}</Text>,
    Redirect: () => null,
    Stack: () => null,
  };
});


// RNTL 14's `render` is async, so this is too — reading `screen` before it
// settles reports "render function has not been called".
async function mount(
  element: ReactElement,
  routes: Parameters<typeof fakeTransport>[0],
) {
  const http = fakeTransport(routes);

  const manager = createSessionManager({
    auth: createAuthApi(createClient('http://api.test', http.transport)),
    storage: fakeStorage(),
  });

  await render(<SessionProvider manager={manager}>{element}</SessionProvider>);

  return http;
}

beforeEach(() => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockParams = {};
});

describe('sign up (AC-10)', () => {
  it('rejects a short password without sending a request', async () => {
    const user = userEvent.setup();
    const http = await mount(<SignUpScreen />, {
      '/auth/register': { status: 201, body: { message: 'ok' } },
    });

    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    // Eleven characters: one short of the API's minimum.
    await user.type(screen.getByLabelText('Password'), 'a'.repeat(11));
    await user.press(screen.getByLabelText('Create account'));

    // The exact field-error string. A loose regex also matches the static
    // "At least 12 characters" hint below the input, which is present before
    // any validation runs — it would pass whether or not the rule fired.
    expect(
      await screen.findByText('Must be at least 12 characters.'),
    ).toBeTruthy();
    // Not merely "shows an error" — the request must not be spent. The API
    // allows ten a minute and a round trip to learn what we already know is
    // one of them.
    expect(http.countOf('/auth/register')).toBe(0);
  });

  it('submits the credentials and routes to check-email on 201', async () => {
    const user = userEvent.setup();
    const http = await mount(<SignUpScreen />, {
      '/auth/register': { status: 201, body: { message: 'Check your email' } },
    });

    await user.type(screen.getByLabelText('Email'), ' someone@example.com ');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.press(screen.getByLabelText('Create account'));

    await waitFor(() => expect(http.countOf('/auth/register')).toBe(1));

    const body = JSON.parse(String(http.calls[0]!.init.body));
    expect(body).toEqual({
      email: 'someone@example.com',
      password: 'correct-horse-battery',
    });

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/check-email',
        params: { email: 'someone@example.com' },
      }),
    );
  });

  it('renders per-field messages from a 400', async () => {
    const user = userEvent.setup();
    await mount(<SignUpScreen />, {
      '/auth/register': {
        status: 400,
        body: {
          error: 'Validation failed',
          fields: { email: 'must be a valid email address' },
        },
      },
    });

    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.press(screen.getByLabelText('Create account'));

    expect(
      await screen.findByText('must be a valid email address'),
    ).toBeTruthy();
  });
});

describe('sign in (AC-11)', () => {
  it('shows one message for a 401 and does not name the cause', async () => {
    const user = userEvent.setup();
    await mount(<SignInScreen />, {
      '/auth/login': { status: 401, body: { error: 'Invalid email or password' } },
    });

    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password-here');
    await user.press(screen.getByLabelText('Sign in'));

    // The alert says exactly this and nothing else. Asserting on the alert's
    // own text rather than sweeping the screen: "No account? Create one" is
    // the sign-up link and always present, so a blanket search for phrases
    // like /no account/ matches ordinary navigation copy and would fail even
    // on a correct implementation.
    const alert = await screen.findByRole('alert');

    // Exactly the shared constant — the message names both halves without
    // saying which was wrong ("Email or password is incorrect"). That the two
    // causes map to the SAME string is asserted in client.test.ts, where both
    // 401 variants can be compared directly.
    expect(alert).toHaveTextContent(SIGN_IN_FAILED);
  });

  it('routes an unverified account to check-email with the address', async () => {
    const user = userEvent.setup();
    await mount(<SignInScreen />, {
      '/auth/login': {
        status: 403,
        body: { error: 'Email not verified', code: 'EMAIL_NOT_VERIFIED' },
      },
    });

    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.press(screen.getByLabelText('Sign in'));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/check-email',
        params: { email: 'someone@example.com' },
      }),
    );
  });

  it('counts down on 429 rather than showing a generic error', async () => {
    const user = userEvent.setup();
    await mount(<SignInScreen />, {
      '/auth/login': {
        status: 429,
        body: { error: 'Rate limit exceeded' },
        headers: { 'retry-after': '45' },
      },
    });

    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.press(screen.getByLabelText('Sign in'));

    expect(
      await screen.findByText('Too many attempts. Try again in 45 seconds.'),
    ).toBeTruthy();
  });

  it('signs in on 200 without routing by hand', async () => {
    const user = userEvent.setup();
    const http = await mount(<SignInScreen />, {
      '/auth/login': { status: 200, body: session() },
    });

    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.press(screen.getByLabelText('Sign in'));

    await waitFor(() => expect(http.countOf('/auth/login')).toBe(1));
    // The group guard moves the user; a manual mockPush here would fight it.
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe('check email (AC-12)', () => {
  it('shows the address it was given', async () => {
    mockParams = { email: 'someone@example.com' };
    await mount(<CheckEmailScreen />, {});

    expect(screen.getByText(/someone@example.com/)).toBeTruthy();
  });

  /**
   * The resend endpoint answers the same 202 for an unknown address, an
   * already-verified one, and a throttled one — that uniformity is what stops
   * it being an account-enumeration oracle. The screen must not undo it by
   * rendering the outcome, so the confirmation is identical even for a 500.
   */
  it.each([
    ['202', { status: 202, body: { message: 'Verification email sent' } }],
    ['500', { status: 500, body: { error: 'Internal Server Error' } }],
    ['429', { status: 429, body: { error: 'Rate limit exceeded' } }],
  ])('renders one fixed confirmation for a %s', async (_label, reply) => {
    mockParams = { email: 'someone@example.com' };
    const user = userEvent.setup();
    await mount(<CheckEmailScreen />, { '/auth/resend-verification': reply });

    await user.press(screen.getByLabelText('Resend email'));

    expect(await screen.findByText(RESEND_CONFIRMATION)).toBeTruthy();
  });

  it('returns to sign-in from the verified button', async () => {
    mockParams = { email: 'someone@example.com' };
    const user = userEvent.setup();
    await mount(<CheckEmailScreen />, {});

    await user.press(screen.getByLabelText("I've verified — sign in"));

    expect(mockReplace).toHaveBeenCalledWith('/sign-in');
  });
});
