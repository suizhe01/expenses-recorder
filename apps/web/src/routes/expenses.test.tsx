import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import { expenseQuery, type Expense } from '@/api/expenses';
import { ExpensesScreen, groupExpenses, monthLabel } from '@/routes/expenses';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, session } from '@/test/support';

const expenses: Expense[] = [
  { id: 'one', category: { id: 'cat-1', name: 'Food' }, receiptId: null, totalCents: 1200, purchasedOn: '2026-08-01', currency: 'MYR', merchantName: 'Kopitiam', receiptNumber: 'R-1', note: 'Breakfast' },
  { id: 'two', category: { id: 'cat-1', name: 'Food' }, receiptId: 'receipt-1', totalCents: 750, purchasedOn: '2026-08-01', currency: 'SGD', merchantName: 'Market', receiptNumber: null, note: null },
  { id: 'three', category: { id: 'cat-2', name: 'Travel' }, receiptId: null, totalCents: 3000, purchasedOn: '2026-07-31', currency: 'MYR', merchantName: null, receiptNumber: null, note: 'Train' },
];

async function mount(rows: Expense[] = expenses) {
  const calls: string[] = [];
  const api = { create: vi.fn(), list: vi.fn(async (_token: string, filters) => { calls.push(expenseQuery(filters)); return { kind: 'ok' as const, status: 200, body: rows }; }) };
  const categoriesApi = { list: vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: [{ id: 'cat-1', name: 'Food', createdAt: '', updatedAt: '' }] })) };
  const manager = createSessionManager({ auth: createAuthApi(createClient('', async () => new Response(JSON.stringify(session()), { status: 200 }))), storage: fakeStorage() });
  await manager.signIn('someone@example.com', 'password');
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={['/expenses']}><ExpensesScreen expensesApi={api} categoriesApi={categoriesApi} /></MemoryRouter></SessionProvider>);
  return { calls, api };
}

describe('expense list', () => {
  it('groups by date strings under UTC and Malaysia time, and never combines currencies', () => {
    const groups = groupExpenses(expenses);
    expect(monthLabel(groups[0]!.month)).toBe('August 2026');
    expect(groups[0]!.totals).toEqual(new Map([['MYR', 1200], ['SGD', 750]]));
    expect(monthLabel(groupExpenses([{ ...expenses[0]!, purchasedOn: '2026-08-01' }])[0]!.month)).toBe('August 2026');
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

  it('shows nothing-filed rather than a filtered empty state for an empty archive', async () => {
    await mount([]);
    expect(await screen.findByText('Nothing filed yet')).toBeInTheDocument();
  });
});
