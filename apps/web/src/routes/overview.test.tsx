import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import type { Expense } from '@/api/expenses';
import type { Receipt } from '@/api/receipts';
import { OverviewScreen } from '@/routes/overview';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, session } from '@/test/support';
import { CLIENT_ROUTES, confirmReceiptPath } from '@/client-routes';

const expenses: Expense[] = [
  { id: 'one', category: { id: 'food', name: 'Food' }, receiptId: null, totalCents: 1200, purchasedOn: '2026-08-01', currency: 'MYR', merchantName: null, receiptNumber: null, note: null },
  { id: 'two', category: { id: 'travel', name: 'Travel' }, receiptId: null, totalCents: 800, purchasedOn: '2026-08-02', currency: 'MYR', merchantName: null, receiptNumber: null, note: null },
  { id: 'three', category: { id: 'food', name: 'Food' }, receiptId: null, totalCents: 900, purchasedOn: '2026-07-01', currency: 'MYR', merchantName: null, receiptNumber: null, note: null },
  { id: 'four', category: { id: 'food', name: 'Food' }, receiptId: null, totalCents: 5000, purchasedOn: '2026-08-01', currency: 'SGD', merchantName: null, receiptNumber: null, note: null },
];
const receipt: Receipt = { id: 'receipt-1', contentType: 'image/jpeg', byteSize: 3, originalFilename: 'lunch.jpg', createdAt: '2026-08-01T00:00:00Z', expenseId: null, extraction: null };

async function mount(rows = expenses, receipts: Receipt[] = [receipt]) {
  const manager = createSessionManager({ auth: createAuthApi(createClient('', async () => new Response(JSON.stringify(session()), { status: 200 }))), storage: fakeStorage() });
  await manager.signIn('person@example.com', 'password');
  const expensesApi = { create: vi.fn(), list: vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: rows })) };
  const receiptsApi = { list: vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: receipts })), upload: vi.fn(), remove: vi.fn(), image: vi.fn() };
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[CLIENT_ROUTES.home]}><Routes><Route path={CLIENT_ROUTES.home} element={<OverviewScreen expensesApi={expensesApi} receiptsApi={receiptsApi} />} /><Route path={CLIENT_ROUTES.confirmReceipt} element={<h1>Confirm receipt</h1>} /></Routes></MemoryRouter></SessionProvider>);
}

describe('overview', () => {
  it('renders the summary, keeps currencies separate, and exposes a receipt-to-file link', async () => {
    await mount();
    expect((await screen.findAllByText('RM 20.00')).length).toBeGreaterThan(0);
    expect(screen.getByText('↑ 122% vs last month')).toBeInTheDocument();
    expect(screen.getByLabelText('Overview currency')).toBeInTheDocument();
    expect(screen.getByText('1 to file')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /lunch.jpg/i })).toHaveAttribute('href', confirmReceiptPath('receipt-1'));
    expect(screen.getByRole('link', { name: /overview/i })).toHaveAttribute('aria-current', 'page');
  });
  it('omits the to-file section when no receipt is waiting and shows a capture prompt for an empty archive', async () => {
    await mount([], []);
    expect(await screen.findByText('Nothing filed yet')).toBeInTheDocument();
    expect(screen.getByText('Use the + button to capture your first receipt.')).toBeInTheDocument();
    expect(screen.queryByText(/to file$/)).not.toBeInTheDocument();
  });
  it('keeps an offline FAB upload available for retry without reopening the picker', async () => {
    const uploaded = { ...receipt, extraction: { status: 'succeeded', merchantName: 'Cafe', purchasedOn: '2026-08-01', totalCents: 500, currency: 'MYR' } };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response(JSON.stringify(uploaded), { status: 201, headers: { 'content-type': 'application/json' } })));
    await mount();
    await screen.findAllByText('RM 20.00');
    await userEvent.upload(screen.getByLabelText('Add receipt'), new File(['jpeg'], 'retry.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText('Could not reach the server. Check your connection.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
