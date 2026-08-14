import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import type { Expense } from '@/api/expenses';
import type { Receipt } from '@/api/receipts';
import type { ApiResult } from '@/api/client';
import { OverviewScreen, receiptReviewReason } from '@/routes/overview';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, session } from '@/test/support';
import { CLIENT_ROUTES, confirmReceiptPath } from '@/client-routes';

const blank = { purchasedAtTime: null, subtotalCents: null, taxCents: null, roundingCents: null, merchantTaxId: null, paymentMethod: null, createdAt: '', updatedAt: '' };
const expenses: Expense[] = [
  { id: 'one', category: { id: 'food', name: 'Food' }, receiptId: null, totalCents: 1200, purchasedOn: '2026-08-01', currency: 'MYR', merchantName: null, receiptNumber: null, note: null, ...blank },
  { id: 'two', category: { id: 'travel', name: 'Travel' }, receiptId: null, totalCents: 800, purchasedOn: '2026-08-02', currency: 'MYR', merchantName: null, receiptNumber: null, note: null, ...blank },
  { id: 'three', category: { id: 'food', name: 'Food' }, receiptId: null, totalCents: 900, purchasedOn: '2026-07-01', currency: 'MYR', merchantName: null, receiptNumber: null, note: null, ...blank },
  { id: 'four', category: { id: 'food', name: 'Food' }, receiptId: null, totalCents: 5000, purchasedOn: '2026-08-01', currency: 'SGD', merchantName: null, receiptNumber: null, note: null, ...blank },
];
const receipt: Receipt = { id: 'receipt-1', contentType: 'image/jpeg', byteSize: 3, originalFilename: 'lunch.jpg', createdAt: '2026-08-01T00:00:00Z', expenseId: null, extraction: null };
const readReceipt: Receipt = { ...receipt, id: 'receipt-2', originalFilename: 'read.jpg', extraction: { status: 'succeeded', isReceipt: true, merchantName: null, purchasedOn: '2026-08-01', totalCents: 1200, currency: 'MYR', items: [] } };

async function mount(rows = expenses, receipts: Receipt[] = [receipt], removeResult: ApiResult<void> = { kind: 'ok', status: 204, body: undefined }) {
  const manager = createSessionManager({ auth: createAuthApi(createClient('', async () => new Response(JSON.stringify(session()), { status: 200 }))), storage: fakeStorage() });
  await manager.signIn('person@example.com', 'password');
  const expensesApi = { create: vi.fn(), list: vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: rows })) };
  const receiptsApi = { list: vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: receipts })), upload: vi.fn(), remove: vi.fn(async () => removeResult), image: vi.fn() };
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[CLIENT_ROUTES.home]}><Routes><Route path={CLIENT_ROUTES.home} element={<OverviewScreen expensesApi={expensesApi} receiptsApi={receiptsApi} />} /><Route path={CLIENT_ROUTES.confirmReceipt} element={<h1>Confirm receipt</h1>} /></Routes></MemoryRouter></SessionProvider>);
  return { receiptsApi };
}

describe('overview', () => {
  it.each([
    [{ ...receipt, extraction: null }, "Couldn't read receipt"],
    [{ ...receipt, extraction: { ...readReceipt.extraction!, status: 'skipped' } }, "Couldn't read receipt"],
    [{ ...receipt, extraction: { ...readReceipt.extraction!, isReceipt: false, purchasedOn: null, totalCents: null } }, "Doesn't look like a receipt"],
    [{ ...receipt, extraction: { ...readReceipt.extraction!, purchasedOn: null, totalCents: null } }, 'Missing date'],
    [{ ...receipt, extraction: { ...readReceipt.extraction!, totalCents: null } }, 'Missing total'],
    [readReceipt, null],
  ])('EXP-55 classifies a receipt as %s', (value, expected) => {
    expect(receiptReviewReason(value)).toBe(expected);
  });

  it('renders the summary, keeps currencies separate, and exposes a receipt-to-file link', async () => {
    await mount(expenses, [readReceipt]);
    expect((await screen.findAllByText('RM 20.00')).length).toBeGreaterThan(0);
    expect(screen.getByText('↑ 122% vs last month')).toBeInTheDocument();
    expect(screen.getByLabelText('Overview currency')).toBeInTheDocument();
    expect(screen.getByText('1 to file')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /read.jpg/i })).toHaveAttribute('href', confirmReceiptPath('receipt-2'));
    expect(screen.getByRole('link', { name: /overview/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', CLIENT_ROUTES.settings);
  });
  it('omits the to-file section when no receipt is waiting and shows a capture prompt for an empty archive', async () => {
    await mount([], []);
    expect(await screen.findByText('Nothing filed yet')).toBeInTheDocument();
    expect(screen.getByText('Use the + button to capture your first receipt.')).toBeInTheDocument();
    expect(screen.queryByText(/to file$/)).not.toBeInTheDocument();
  });
  it('EXP-55 separates receipts needing review from ready receipts without flagging missing merchant or items', async () => {
    const missingTotal = { ...receipt, id: 'needs-total', originalFilename: 'total.jpg', extraction: { ...readReceipt.extraction!, totalCents: null } };
    const missingMerchantAndItems = { ...readReceipt, id: 'ready', originalFilename: 'ready.jpg', extraction: { ...readReceipt.extraction!, merchantName: null, items: [] } };
    await mount(expenses, [missingTotal, missingMerchantAndItems]);
    expect(await screen.findByRole('heading', { name: '1 needs review' })).toBeInTheDocument();
    expect(screen.getByText('Missing total')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1 to file' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /total.jpg.*review/i })).toHaveAttribute('href', confirmReceiptPath('needs-total'));
    expect(screen.getByRole('link', { name: /ready.jpg.*file receipt/i })).toHaveAttribute('href', confirmReceiptPath('ready'));
  });
  it('EXP-55 keeps receipt deletion working from Needs review', async () => {
    const { receiptsApi } = await mount(expenses, [receipt]);
    await screen.findByRole('heading', { name: '1 needs review' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete lunch.jpg' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(receiptsApi.remove).toHaveBeenCalledWith(expect.any(String), 'receipt-1');
    expect(screen.queryByRole('heading', { name: '1 needs review' })).not.toBeInTheDocument();
  });
  it('EXP-42 AC-1 to AC-3: deletes from the to-file list without navigating', async () => {
    const { receiptsApi } = await mount(expenses, [readReceipt]);
    await screen.findByText('1 to file');
    await userEvent.click(screen.getByRole('button', { name: 'Delete read.jpg' }));
    expect(screen.getByRole('heading', { name: 'Delete receipt?' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Confirm receipt' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(receiptsApi.remove).toHaveBeenCalledWith(expect.any(String), 'receipt-2');
    expect(screen.queryByText('1 to file')).not.toBeInTheDocument();
    expect(screen.queryByText('read.jpg')).not.toBeInTheDocument();
  });
  it('EXP-42 AC-2: cancel keeps the receipt untouched', async () => {
    await mount(expenses, [readReceipt]);
    await screen.findByText('1 to file');
    await userEvent.click(screen.getByRole('button', { name: 'Delete read.jpg' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('1 to file')).toBeInTheDocument();
    expect(screen.getByText('read.jpg')).toBeInTheDocument();
  });
  it('EXP-42 AC-4: keeps the dialog and row on an attached receipt error', async () => {
    await mount(expenses, [readReceipt], { kind: 'error' as const, status: 409, message: 'Conflict' });
    await screen.findByText('1 to file');
    await userEvent.click(screen.getByRole('button', { name: 'Delete read.jpg' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('This receipt is attached to an expense. Delete the expense first.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Delete receipt?' })).toBeInTheDocument();
    expect(screen.getByText('read.jpg')).toBeInTheDocument();
  });
});
