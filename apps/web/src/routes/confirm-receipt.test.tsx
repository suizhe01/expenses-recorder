import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import { ConfirmReceiptScreen } from '@/routes/confirm-receipt';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, session } from '@/test/support';
import { CLIENT_ROUTES, confirmReceiptPath } from '@/client-routes';
import type { Receipt } from '@/api/receipts';

const receipt: Receipt = { id: 'receipt-1', contentType: 'image/jpeg', byteSize: 4, originalFilename: 'DAY ONE', createdAt: '2026-08-12T00:00:00Z', expenseId: null, extraction: { status: 'failed', isReceipt: false, merchantName: null, purchasedOn: null, totalCents: null, currency: null } };
const category = { id: '00000000-0000-0000-0000-000000000002', name: 'Food', createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z' };

async function mount(fileStatus = 503, expense: { status: number; body: unknown } = { status: 201, body: { id: 'expense-1' } }, holdExpense = false, loadedReceipt: Receipt = receipt) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://test.local').pathname; calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/receipts') return new Response(JSON.stringify([loadedReceipt]), { status: 200 });
    if (path === '/categories') return new Response(JSON.stringify([category]), { status: 200 });
    if (path === '/receipts/receipt-1/file') return new Response(fileStatus === 200 ? new Blob(['image']) : JSON.stringify({ error: 'Unavailable' }), { status: fileStatus });
    if (path === '/expenses' && holdExpense) return new Promise<Response>(() => undefined);
    if (path === '/expenses') return new Response(JSON.stringify(expense.body), { status: expense.status });
    return new Response(null, { status: 404 });
  }));
  const manager = createSessionManager({ auth: createAuthApi(createClient('', async () => new Response(JSON.stringify(session()), { status: 200 }))), storage: fakeStorage() });
  await manager.signIn('someone@example.com', 'password');
  const view = render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[confirmReceiptPath('receipt-1')]}><Routes><Route path={CLIENT_ROUTES.confirmReceipt} element={<ConfirmReceiptScreen />} /><Route path={CLIENT_ROUTES.home} element={<p>Inbox</p>} /></Routes></MemoryRouter></SessionProvider>);
  await screen.findByRole('heading', { name: 'Confirm receipt' });
  return { calls, view };
}

beforeEach(() => { vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:receipt'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('confirm receipt', () => {
  it('keeps a failed-image receipt savable and does not post without a category', async () => {
    const { calls } = await mount();
    expect(await screen.findByText('Receipt image is unavailable')).toBeInTheDocument();
    expect(screen.getByText("We couldn't read this receipt — enter the details yourself.")).toBeInTheDocument();
    expect(screen.getByText("This doesn't look like a receipt. Check the photo before saving.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save expense' })).toBeDisabled();
    expect(calls.filter((call) => call === 'POST /expenses')).toHaveLength(0);
  });

  it('revokes the image URL and expands a hidden-field error', async () => {
    const { view } = await mount(200, { status: 400, body: { error: 'Validation failed', fields: { taxCents: 'Bad tax' } } });
    await userEvent.selectOptions(screen.getByLabelText('Category'), category.id);
    await userEvent.clear(screen.getByLabelText('Total')); await userEvent.type(screen.getByLabelText('Total'), '149.30');
    const save = screen.getByRole('button', { name: 'Save expense' });
    await userEvent.click(save);
    expect(await screen.findByText('Bad tax')).toBeInTheDocument();
    expect(screen.getByLabelText('Tax')).toBeInTheDocument();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:receipt');
  });

  it('makes exactly one POST for synchronous double taps while saving', async () => {
    const { calls } = await mount(503, { status: 201, body: { id: 'expense-1' } }, true);
    await userEvent.selectOptions(screen.getByLabelText('Category'), category.id);
    await userEvent.clear(screen.getByLabelText('Total')); await userEvent.type(screen.getByLabelText('Total'), '149.30');
    const save = screen.getByRole('button', { name: 'Save expense' });
    fireEvent.click(save); fireEvent.click(save);
    await waitFor(() => expect(calls.filter((call) => call === 'POST /expenses')).toHaveLength(1));
  });

  it('EXP-41 AC-1 to AC-4: edits extracted items, warns on mismatch, and sends the cleaned array', async () => {
    const extracted = {
      ...receipt,
      extraction: {
        status: 'succeeded', isReceipt: true, merchantName: 'Market', purchasedOn: '2026-08-12',
        totalCents: 1000, subtotalCents: 1000, currency: 'MYR',
        items: [
          { description: 'Rice', quantity: '1', unitPriceCents: 500, lineTotalCents: 500 },
          { description: 'Tea', quantity: '2', unitPriceCents: 250, lineTotalCents: 500 },
        ],
      },
    };
    const { calls } = await mount(503, { status: 201, body: { id: 'expense-1' } }, false, extracted);
    expect(await screen.findByRole('heading', { name: 'Items' })).toBeInTheDocument();
    expect(screen.getAllByLabelText('Description')).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText('Category'), category.id);
    await userEvent.clear(screen.getAllByLabelText('Line total')[0]!);
    await userEvent.type(screen.getAllByLabelText('Line total')[0]!, '4.00');
    expect(screen.getByText(/Item line totals do not match/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save expense' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.queryByText(/Item line totals do not match/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(calls).toContain('POST /expenses'));
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => new URL(url, 'http://test.local').pathname === '/expenses' && init?.method === 'POST');
    expect(JSON.parse((request?.[1] as RequestInit).body as string).items).toEqual([
      { description: 'Rice', quantity: '1', unitPriceCents: 500, lineTotalCents: 400 },
      { description: 'Tea', quantity: '2', unitPriceCents: 250, lineTotalCents: 500 },
    ]);
  });

  it('EXP-41 AC-1, AC-4: keeps no-item receipts clean and validates a manually added amount', async () => {
    await mount();
    expect(screen.queryByRole('heading', { name: 'Items' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More details' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.getByRole('heading', { name: 'Items' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Unit price'), '1.234');
    await userEvent.selectOptions(screen.getByLabelText('Category'), category.id);
    await userEvent.type(screen.getByLabelText('Total'), '1.00');
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText('Use a valid amount with no more than 2 decimal places.')).toBeInTheDocument();
  });

  it('EXP-41 AC-1: removes a line-item row', async () => {
    const extracted = {
      ...receipt,
      extraction: {
        status: 'succeeded', isReceipt: true, merchantName: 'Market', purchasedOn: '2026-08-12',
        totalCents: 1000, currency: 'MYR',
        items: [
          { description: 'Rice', quantity: '1', unitPriceCents: 500, lineTotalCents: 500 },
          { description: 'Tea', quantity: '2', unitPriceCents: 250, lineTotalCents: 500 },
        ],
      },
    };
    await mount(503, { status: 201, body: { id: 'expense-1' } }, false, extracted);
    expect(await screen.findByRole('heading', { name: 'Items' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove item 2' }));
    expect(screen.getAllByLabelText('Description')).toHaveLength(1);
  });
});
