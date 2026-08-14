import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import { AddExpenseScreen } from '@/routes/add-expense';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, session } from '@/test/support';
import { CLIENT_ROUTES } from '@/client-routes';

const category = { id: '00000000-0000-0000-0000-000000000002', name: 'Food', createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z' };
const uploaded = { id: 'receipt-1', contentType: 'image/jpeg', byteSize: 4, originalFilename: 'retry.jpg', createdAt: '2026-08-12T00:00:00Z', expenseId: null, extraction: { status: 'succeeded', merchantName: 'Cafe', purchasedOn: '2026-08-12', totalCents: 500, currency: 'MYR' } };

async function mount() {
  const manager = createSessionManager({ auth: createAuthApi(createClient('', async () => new Response(JSON.stringify(session()), { status: 200 }))), storage: fakeStorage() });
  await manager.signIn('person@example.com', 'password');
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[CLIENT_ROUTES.add]}><Routes><Route path={CLIENT_ROUTES.add} element={<AddExpenseScreen />} /><Route path={CLIENT_ROUTES.confirmReceipt} element={<h1>Confirm receipt</h1>} /></Routes></MemoryRouter></SessionProvider>);
  await screen.findByRole('heading', { name: 'Add expense' });
}

afterEach(() => vi.unstubAllGlobals());

describe('add expense', () => {
  it('keeps an offline photo upload available for retry and opens confirmation after success', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://test.local').pathname;
      if (path === '/categories') return new Response(JSON.stringify([category]), { status: 200 });
      if (path === '/receipts') {
        if ((fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([calledUrl]) => new URL(calledUrl, 'http://test.local').pathname === '/receipts').length === 1) throw new TypeError('offline');
        return new Response(JSON.stringify(uploaded), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    }));
    await mount();
    const camera = screen.getByLabelText('Take photo');
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(camera).toHaveAttribute('accept', 'image/*');
    expect(screen.getByLabelText('Upload photo')).toHaveAttribute('accept', 'image/*');
    await userEvent.upload(screen.getByLabelText('Upload photo'), new File(['jpeg'], 'retry.jpg', { type: 'image/jpeg' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use photo' }));
    expect(await screen.findByText('Could not reach the server. Check your connection.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Confirm receipt' })).toBeInTheDocument();
  });

  it.each([
    [null, 'You already have this receipt.'],
    ['expense-1', "You already have this receipt — it's already filed."],
  ])('keeps a duplicate upload on Add expense (%s)', async (expenseId, notice) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://test.local').pathname;
      if (path === '/categories') return new Response(JSON.stringify([category]), { status: 200 });
      if (path === '/receipts') return new Response(JSON.stringify({ ...uploaded, expenseId }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(null, { status: 404 });
    }));
    await mount();
    await userEvent.upload(screen.getByLabelText('Upload photo'), new File(['jpeg'], 'duplicate.jpg', { type: 'image/jpeg' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use photo' }));
    expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add expense' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Confirm receipt' })).not.toBeInTheDocument();
  });
});
