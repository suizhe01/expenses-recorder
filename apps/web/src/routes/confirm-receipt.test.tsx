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

async function mount(fileStatus = 503, expense: { status: number; body: unknown } = { status: 201, body: { id: 'expense-1' } }, holdExpense = false, loadedReceipt: Receipt = receipt, retry?: { status: number; body: unknown; headers?: HeadersInit; hold?: boolean }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://test.local').pathname; calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/receipts' && init?.method === 'POST' && retry?.hold) return new Promise<Response>(() => undefined);
    if (path === '/receipts' && init?.method === 'POST') return new Response(JSON.stringify(retry?.body), { status: retry?.status ?? 500, headers: retry?.headers });
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
  const successfulRetry: Receipt = { ...receipt, extraction: { status: 'succeeded', isReceipt: true, merchantName: 'Retry Cafe', purchasedOn: '2026-08-12', totalCents: 1234, currency: 'MYR', items: [{ description: 'Tea', quantity: '1', unitPriceCents: 1234, lineTotalCents: 1234 }] } };

  it('EXP-53 AC-7: identifies a local or fallback reading and keeps fields editable', async () => {
    const local = { ...receipt, extraction: { ...receipt.extraction!, status: 'succeeded', source: 'PaddleOCR' as const, merchantName: 'Shell' } };
    const { view } = await mount(200, undefined, false, local);
    expect(await screen.findByText('Read locally with PaddleOCR.')).toBeInTheDocument();
    expect(screen.getByLabelText('Total')).not.toBeDisabled();

    view.unmount();
    const fallback = { ...local, extraction: { ...local.extraction!, source: 'Gemini fallback' as const } };
    await mount(200, undefined, false, fallback);
    expect(await screen.findByText('Read with Gemini fallback.')).toBeInTheDocument();
  });

  it('keeps a failed-image receipt savable and does not post without a category', async () => {
    const { calls } = await mount();
    expect(await screen.findByText('Receipt image is unavailable')).toBeInTheDocument();
    expect(screen.getByText("We couldn't read this receipt — enter the details yourself.")).toBeInTheDocument();
    expect(screen.getByText("This doesn't look like a receipt. Check the photo before saving.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save expense' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(calls.filter((call) => call === 'POST /expenses')).toHaveLength(0);
  });

  it('EXP-48 AC-1 to AC-5: retries the held image and uses the first-load population path', async () => {
    const { calls } = await mount(200, undefined, false, receipt, { status: 200, body: successfulRetry });
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByDisplayValue('Retry Cafe')).toBeInTheDocument();
    expect(screen.getByLabelText('Total')).toHaveValue('12.34');
    expect(screen.getByRole('heading', { name: 'Items' })).toBeInTheDocument();
    expect(calls.filter((call) => call === 'POST /receipts')).toHaveLength(1);
  });

  it('EXP-48 AC-1: offers retry for skipped extractions but never for successful ones', async () => {
    const { view } = await mount(200, undefined, false, { ...receipt, extraction: { ...receipt.extraction!, status: 'skipped' } });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    view.unmount();
    await mount(200, undefined, false, successfulRetry);
    expect(await screen.findByDisplayValue('Retry Cafe')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('EXP-48 AC-4: cancelling replacement preserves typed values and discards the reading', async () => {
    await mount(200, undefined, false, receipt, { status: 200, body: successfulRetry });
    await userEvent.clear(await screen.findByLabelText('Total')); await userEvent.type(screen.getByLabelText('Total'), '7.00');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Total')).toHaveValue('7.00');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('EXP-48 AC-6 to AC-9: preserves manual values for failed retries, reports rate limits, and rejects another receipt', async () => {
    const { view } = await mount(200, undefined, false, receipt, { status: 200, body: { ...receipt, extraction: { ...receipt.extraction!, status: 'failed' } } });
    await userEvent.clear(await screen.findByLabelText('Total')); await userEvent.type(screen.getByLabelText('Total'), '7.00');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('We tried again but still couldn’t read this receipt. Enter the details yourself.')).toBeInTheDocument();
    expect(screen.getByLabelText('Total')).toHaveValue('7.00');
    view.unmount();

    await mount(200, undefined, false, receipt, { status: 429, body: { error: 'Too many uploads' }, headers: { 'retry-after': '41' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Too many uploads. Try again in 41 seconds.')).toBeInTheDocument();
  });

  it('EXP-48 AC-8 and AC-9: disables a retry in flight and never applies another receipt', async () => {
    const { calls, view } = await mount(200, undefined, false, receipt, { status: 200, body: successfulRetry, hold: true });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => expect(calls.filter((call) => call === 'POST /receipts')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeDisabled();
    view.unmount();

    await mount(200, undefined, false, receipt, { status: 200, body: { ...successfulRetry, id: 'receipt-2' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('The new reading did not match this receipt. Nothing was changed.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Retry Cafe')).not.toBeInTheDocument();
  });

  it('EXP-48 AC-10: leaves when the retry response says the receipt was filed', async () => {
    await mount(200, undefined, false, receipt, { status: 200, body: { ...successfulRetry, expenseId: 'expense-1' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Inbox')).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole('button', { name: 'Save only' }));
    await waitFor(() => expect(calls).toContain('POST /expenses'));
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => new URL(url, 'http://test.local').pathname === '/expenses' && init?.method === 'POST');
    expect(JSON.parse((request?.[1] as RequestInit).body as string).items).toEqual([
      { description: 'Rice', quantity: '1', unitPriceCents: 500, lineTotalCents: 400, components: [] },
      { description: 'Tea', quantity: '2', unitPriceCents: 250, lineTotalCents: 500, components: [] },
    ]);
  });

  it('EXP-50 AC-5: reconciles a signed subsidy line against the receipt total', async () => {
    const extracted = { ...receipt, extraction: { status: 'succeeded', isReceipt: true, merchantName: 'Shell', purchasedOn: '2026-08-11', totalCents: 8849, currency: 'MYR', items: [{ description: 'FuelSave 95(Pump 4)', quantity: null, unitPriceCents: null, lineTotalCents: 16765 }, { description: 'BUDI95 Subsidy', quantity: null, unitPriceCents: null, lineTotalCents: -7916 }] } };
    await mount(503, { status: 201, body: { id: 'expense-1' } }, false, extracted);
    expect(await screen.findByRole('heading', { name: 'Items' })).toBeInTheDocument();
    expect(screen.queryByText(/Item line totals do not match/)).not.toBeInTheDocument();
  });

  it('EXP-44 AC-1 to AC-6: edits collapsed components, reconciles their totals, and saves nested items', async () => {
    const extracted = {
      ...receipt,
      extraction: {
        status: 'succeeded', isReceipt: true, merchantName: 'Pokemist', purchasedOn: '2026-08-12',
        totalCents: 5570, subtotalCents: 5570, currency: 'MYR',
        items: [{ description: 'Cajun Chicken', quantity: '3', unitPriceCents: 1790, lineTotalCents: 5370, components: [{ description: 'Add Rice', quantity: '2', unitPriceCents: 100, lineTotalCents: 200 }] }],
      },
    };
    const { calls } = await mount(503, { status: 201, body: { id: 'expense-1' } }, false, extracted);
    const summary = await screen.findByRole('button', { name: '1 component' });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Component 1 description')).not.toBeInTheDocument();
    await userEvent.click(summary);
    expect(screen.getByLabelText('Component 1 description')).toHaveValue('Add Rice');
    expect(screen.queryByText(/Item line totals do not match/)).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Component 1 line total'));
    await userEvent.type(screen.getByLabelText('Component 1 line total'), '1.00');
    expect(screen.getByText(/Item line totals do not match/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Category'), category.id);
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save only' }));
    await waitFor(() => expect(calls).toContain('POST /expenses'));
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => new URL(url, 'http://test.local').pathname === '/expenses' && init?.method === 'POST');
    expect(JSON.parse((request?.[1] as RequestInit).body as string).items).toEqual([{ description: 'Cajun Chicken', quantity: '3', unitPriceCents: 1790, lineTotalCents: 5370, components: [{ description: 'Add Rice', quantity: '2', unitPriceCents: 100, lineTotalCents: 100 }] }]);
  });

  it('EXP-44 AC-3, AC-5, AC-6: retains component-only items and blocks invalid component amounts', async () => {
    const extracted = { ...receipt, extraction: { status: 'succeeded', isReceipt: true, merchantName: 'Set', purchasedOn: '2026-08-12', totalCents: 100, currency: 'MYR', items: [{ description: null, quantity: null, unitPriceCents: null, lineTotalCents: null, components: [{ description: 'Soup', quantity: null, unitPriceCents: null, lineTotalCents: null }] }] } };
    const { calls } = await mount(503, { status: 201, body: { id: 'expense-1' } }, false, extracted);
    await userEvent.click(await screen.findByRole('button', { name: '1 component' }));
    await userEvent.clear(screen.getByLabelText('Component 1 unit price'));
    await userEvent.type(screen.getByLabelText('Component 1 unit price'), '1.234');
    await userEvent.selectOptions(screen.getByLabelText('Category'), category.id);
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }));
    expect(await screen.findByText('Use a valid amount with no more than 2 decimal places.')).toBeInTheDocument();
    expect(calls).not.toContain('POST /expenses');
    await userEvent.clear(screen.getByLabelText('Component 1 unit price'));
    await userEvent.type(screen.getByLabelText('Component 1 unit price'), '1.00');
    expect(screen.queryByText('Use a valid amount with no more than 2 decimal places.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save only' }));
    await waitFor(() => expect(calls).toContain('POST /expenses'));
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => new URL(url, 'http://test.local').pathname === '/expenses' && init?.method === 'POST');
    expect(JSON.parse((request?.[1] as RequestInit).body as string).items).toEqual([{ description: null, quantity: null, unitPriceCents: null, lineTotalCents: null, components: [{ description: 'Soup', quantity: null, unitPriceCents: 100, lineTotalCents: null }] }]);
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

  it('EXP-44 AC-1: removes a nested component', async () => {
    const extracted = {
      ...receipt,
      extraction: {
        status: 'succeeded', isReceipt: true, merchantName: 'Market', purchasedOn: '2026-08-12', totalCents: 500, currency: 'MYR',
        items: [{ description: 'Meal', quantity: '1', unitPriceCents: 500, lineTotalCents: 500, components: [{ description: 'Rice', quantity: '1', unitPriceCents: 100, lineTotalCents: 100 }] }],
      },
    };
    await mount(503, { status: 201, body: { id: 'expense-1' } }, false, extracted);
    await userEvent.click(await screen.findByRole('button', { name: '1 component' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove component 1 from item 1' }));
    expect(screen.queryByLabelText('Component 1 description')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 component' })).not.toBeInTheDocument();
  });
});
