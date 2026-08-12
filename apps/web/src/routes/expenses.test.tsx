import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import { expenseQuery, type Expense } from '@/api/expenses';
import type { ExportsApi } from '@/api/exports';
import type { DownloadResult } from '@/export/download';
import { ExpensesScreen, groupExpenses, monthKey, monthLabel } from '@/routes/expenses';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, session } from '@/test/support';
import { CLIENT_ROUTES } from '@/client-routes';

const blank = { purchasedAtTime: null, subtotalCents: null, taxCents: null, roundingCents: null, merchantTaxId: null, paymentMethod: null, createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:00:00.000Z' };

const expenses: Expense[] = [
  { id: 'one', category: { id: 'cat-1', name: 'Food' }, receiptId: null, totalCents: 1200, purchasedOn: '2026-08-01', currency: 'MYR', merchantName: 'Kopitiam', receiptNumber: 'R-1', note: 'Breakfast', ...blank },
  { id: 'two', category: { id: 'cat-1', name: 'Food' }, receiptId: 'receipt-1', totalCents: 750, purchasedOn: '2026-08-01', currency: 'SGD', merchantName: 'Market', receiptNumber: null, note: null, ...blank },
  { id: 'three', category: { id: 'cat-2', name: 'Travel' }, receiptId: null, totalCents: 3000, purchasedOn: '2026-07-31', currency: 'MYR', merchantName: null, receiptNumber: null, note: 'Train', ...blank },
];

async function mount(rows: Expense[] = expenses, initialPath: string | { pathname: string; state: unknown } = CLIENT_ROUTES.expenses, deletedCategory = false, options: { mint?: ExportsApi['createToken']; csv?: (token: string, filters: Parameters<typeof import('@/export/download').downloadCsv>[1]) => Promise<DownloadResult>; navigate?: (url: string) => void } = {}) {
  const calls: string[] = [];
  const api = { create: vi.fn(), list: vi.fn(async (_token: string, filters) => { calls.push(expenseQuery(filters)); return deletedCategory && filters.categoryId?.length ? { kind: 'error' as const, status: 422, message: 'Category not found' } : { kind: 'ok' as const, status: 200, body: rows }; }) };
  const categoriesApi = { list: vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: [{ id: 'cat-1', name: 'Food', createdAt: '', updatedAt: '' }] })) };
  const manager = createSessionManager({ auth: createAuthApi(createClient('', async () => new Response(JSON.stringify(session()), { status: 200 }))), storage: fakeStorage() });
  await manager.signIn('someone@example.com', 'password');
  const exportsApi = { createToken: options.mint ?? vi.fn(async () => ({ kind: 'ok' as const, status: 201, body: { token: 'download-token', expiresAt: '' } })) };
  const csvDownload = options.csv ?? vi.fn(async () => ({ ok: true } as const));
  const zipNavigate = options.navigate ?? vi.fn();
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[initialPath]}><ExpensesScreen expensesApi={api} categoriesApi={categoriesApi} exportsApi={exportsApi} csvDownload={csvDownload} zipNavigate={zipNavigate} /></MemoryRouter></SessionProvider>);
  return { calls, api, exportsApi, csvDownload, zipNavigate };
}

describe('expense list', () => {
  it('groups by date strings under UTC and Malaysia time, and never combines currencies', () => {
    const groups = groupExpenses(expenses);
    expect(monthLabel(groups[0]!.month)).toBe('August 2026');
    expect(groups[0]!.totals).toEqual(new Map([['MYR', 1200], ['SGD', 750]]));
    expect(monthLabel(groupExpenses([{ ...expenses[0]!, purchasedOn: '2026-08-01' }])[0]!.month)).toBe('August 2026');
  });

  it('EXP-36 AC-6: keeps a date-only first of month in its own month west of UTC', () => {
    // `new Date('2026-08-01')` would render July in America/New_York. The
    // production helper must remain string-only, and CI runs this suite there.
    expect(monthLabel(monthKey('2026-08-01'))).toBe('August 2026');
  });

  it('omits an empty query string and encodes only active API filters', () => {
    expect(expenseQuery({})).toBe('');
    expect(expenseQuery({ from: '2026-08-01', categoryId: ['cat-1', 'cat-2'], hasReceipt: false })).toBe('?from=2026-08-01&categoryId=cat-1&categoryId=cat-2&hasReceipt=false');
  });

  it('searches locally without another request and exposes distinct empty states', async () => {
    const { calls } = await mount();
    expect(await screen.findByText('Kopitiam')).toBeInTheDocument();
    expect(calls).toEqual(['']);
    await userEvent.type(screen.getByRole('textbox', { name: 'Search expenses' }), 'no match');
    expect(await screen.findByText('No expenses match')).toBeInTheDocument();
    expect(calls).toEqual(['']);
    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(await screen.findByText('Kopitiam')).toBeInTheDocument();
  });

  it('refetches once when a filter is applied and gives the list semantic navigation', async () => {
    const { calls } = await mount();
    await screen.findByText('Kopitiam');
    await userEvent.click(screen.getByRole('button', { name: /filters/i }));
    expect(screen.getByRole('dialog')).toHaveClass('bottom-0', 'rounded-t-2xl');
    await userEvent.clear(screen.getByLabelText('From'));
    await userEvent.type(screen.getByLabelText('From'), '2026-08-01');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(calls).toEqual(['', '?from=2026-08-01']));
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /expenses/i })).toHaveAttribute('aria-current', 'page');
  });

  it('opens the detail screen from a row and shows what the detail screen sent back', async () => {
    await mount();
    expect(await screen.findByRole('link', { name: /Kopitiam/ })).toHaveAttribute('href', '/expense/one');
    cleanup();
    await mount(expenses, { pathname: CLIENT_ROUTES.expenses, state: { notice: 'Expense not found' } });
    expect(await screen.findByText('Expense not found')).toBeInTheDocument();
  });

  it('shows nothing-filed rather than a filtered empty state for an empty archive', async () => {
    await mount([]);
    expect(await screen.findByText('Nothing filed yet')).toBeInTheDocument();
  });

  it('reserves the safe-area-aware tab bar height below the final row', async () => {
    await mount();
    await screen.findByText('Kopitiam');
    expect(screen.getByRole('main')).toHaveClass('pb-[calc(5.5rem+env(safe-area-inset-bottom))]');
  });

  it('keeps the deleted-category message visible while clearing only its URL filter', async () => {
    const { calls } = await mount(expenses, `${CLIENT_ROUTES.expenses}?from=2026-08-01&hasReceipt=false&categoryId=cat-deleted`, true);
    expect(await screen.findByText('That category was deleted')).toBeInTheDocument();
    await waitFor(() => expect(calls).toEqual(['?from=2026-08-01&categoryId=cat-deleted&hasReceipt=false', '?from=2026-08-01&hasReceipt=false']));
    expect(screen.getByText('That category was deleted')).toBeInTheDocument();
  });

  it('EXP-35 AC-1, AC-2, AC-8 and AC-11: explains filtered export scope and ZIP contents', async () => {
    await mount(expenses, `${CLIENT_ROUTES.expenses}?from=2026-08-01&hasReceipt=false`);
    await screen.findByText('Kopitiam');
    await userEvent.type(screen.getByRole('textbox', { name: 'Search expenses' }), 'Kopitiam');
    await userEvent.click(screen.getByRole('button', { name: 'Export expenses' }));
    expect(screen.getByText(/dates 2026-08-01 to today; expenses without receipts: 3 expenses/i)).toBeInTheDocument();
    expect(screen.getByText(/Search text is not applied/i)).toBeInTheDocument();
    expect(screen.getByText(/Includes receipt images plus expenses.csv/i)).toBeInTheDocument();
  });

  it('EXP-35 AC-6, AC-7, AC-12: starts CSV once, disables both buttons, and keeps empty exports available', async () => {
    let resolve!: (value: { ok: true }) => void;
    const csv = vi.fn(() => new Promise<{ ok: true }>((done) => { resolve = done; }));
    await mount([], CLIENT_ROUTES.expenses, false, { csv });
    await screen.findByText('Nothing filed yet');
    await userEvent.click(screen.getByRole('button', { name: 'Export expenses' }));
    expect(screen.getByText(/header-only file/i)).toBeInTheDocument();
    const csvButton = screen.getByRole('button', { name: 'Download CSV' });
    await userEvent.click(csvButton);
    expect(screen.getByRole('button', { name: 'Starting CSV…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download ZIP' })).toBeDisabled();
    await userEvent.click(csvButton);
    expect(csv).toHaveBeenCalledOnce();
    resolve({ ok: true });
    expect(await screen.findByText("Download started. Check your browser's downloads.")).toBeInTheDocument();
  });

  it('EXP-35 AC-4, AC-5 and AC-10: mints once then navigates ZIP; failure keeps the sheet open', async () => {
    const mint = vi.fn(async () => ({ kind: 'ok' as const, status: 201, body: { token: 'download-token', expiresAt: '' } }));
    const navigate = vi.fn();
    await mount(expenses, CLIENT_ROUTES.expenses, false, { mint, navigate });
    await screen.findByText('Kopitiam');
    await userEvent.click(screen.getByRole('button', { name: 'Export expenses' }));
    await userEvent.click(screen.getByRole('button', { name: 'Download ZIP' }));
    expect(mint).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/expenses/export.zip?token=download-token');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    cleanup();
    const failedMint = vi.fn(async () => ({ kind: 'error' as const, status: 500, message: 'nope' }));
    await mount(expenses, CLIENT_ROUTES.expenses, false, { mint: failedMint });
    await screen.findByText('Kopitiam');
    await userEvent.click(screen.getByRole('button', { name: 'Export expenses' }));
    await userEvent.click(screen.getByRole('button', { name: 'Download ZIP' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start the download. Please try again.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
