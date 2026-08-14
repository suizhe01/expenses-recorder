import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstallAppButton } from '@/components/install-app';

function installEvent(outcome: 'accepted' | 'dismissed' = 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: ReturnType<typeof vi.fn>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

describe('InstallAppButton', () => {
  it('only appears after the browser exposes an install prompt and hides after use', async () => {
    render(<InstallAppButton />);
    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();
    const event = installEvent();
    window.dispatchEvent(event);
    expect(await screen.findByRole('button', { name: 'Install app' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Install app' }));
    expect(event.prompt).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument());
  });

  it('hides when the app is installed without using the button', async () => {
    render(<InstallAppButton />);
    window.dispatchEvent(installEvent('accepted'));
    await screen.findByRole('button', { name: 'Install app' });
    window.dispatchEvent(new Event('appinstalled'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument());
  });
});
