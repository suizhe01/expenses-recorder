import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createClient } from '@/api/client';
import { createAuthApi } from '@/api/auth';
import { CLIENT_ROUTES } from '@/client-routes';
import { SettingsScreen } from '@/routes/settings';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, session } from '@/test/support';

async function renderSettings() {
  const manager = createSessionManager({
    auth: createAuthApi(
      createClient('', async () => new Response(JSON.stringify(session()), { status: 200 })),
    ),
    storage: fakeStorage(),
  });
  await manager.signIn('person@example.com', 'password');

  render(
    <SessionProvider manager={manager}>
      <MemoryRouter initialEntries={[CLIENT_ROUTES.settings]}>
        <SettingsScreen />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('settings', () => {
  /**
   * Reported: Settings was a dead end. It carries no TabBar, and unlike every
   * other screen with a header — Categories, Confirm receipt, Expense detail,
   * Add expense — it had no back control, so the only way out was browser back.
   */
  it('offers a back control to the overview', async () => {
    await renderSettings();

    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute(
      'href',
      CLIENT_ROUTES.home,
    );
  });

  /**
   * A Link, not navigate(-1). Settings is a real route, so on a direct load or
   * a reload there is no history entry to pop and a -1 button would silently do
   * nothing — the exact failure this fix exists to remove.
   */
  it('routes back by href so a direct load can still leave', async () => {
    await renderSettings();

    const back = screen.getByRole('link', { name: 'Back' });
    expect(back.tagName).toBe('A');
    expect(back).toHaveAttribute('href');
  });

  it('still reaches categories and offers sign out', async () => {
    await renderSettings();

    expect(screen.getByRole('link', { name: /Categories/ })).toHaveAttribute(
      'href',
      CLIENT_ROUTES.categories,
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});
