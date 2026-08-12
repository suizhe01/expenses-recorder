import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient, type ApiResult } from '@/api/client';
import type { Expense, ExpensePatch } from '@/api/expenses';
import type { Receipt } from '@/api/receipts';
import { ExpenseDetailScreen } from '@/routes/expense-detail';
import { HomeScreen } from '@/routes/home';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, session } from '@/test/support';

const filed: Expense = {
  id: 'exp-1', category: { id: 'cat-1', name: 'Food' }, receiptId: 'receipt-1',
  totalCents: 14930, purchasedOn: '2026-08-01', purchasedAtTime: '14:31:00',
  subtotalCents: null, taxCents: null, roundingCents: null, currency: 'MYR',
  merchantName: 'Kopitiam', merchantTaxId: null, receiptNumber: 'R-1',
  paymentMethod: null, note: null,
  createdAt: '2026-08-01T06:31:00.000Z', updatedAt: '2026-08-01T06:31:00.000Z',
};

const manual: Expense = { ...filed, id: 'exp-2', receiptId: null };
const categories = [{ id: 'cat-1', name: 'Food', createdAt: '', updatedAt: '' }, { id: 'cat-2', name: 'Travel', createdAt: '', updatedAt: '' }];

type Options = {
  row?: Expense;
  get?: ApiResult<Expense>;
  update?: ApiResult<Expense>;
  remove?: ApiResult<void>;
  image?: ApiResult<Blob>;
  hold?: boolean;
  /** What the API really does: the row is gone, so a second DELETE is a 404. */
  deleteOnce?: boolean;
};

function Archive() {
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  return <p>Archive{notice ? `: ${notice}` : ''}</p>;
}

async function mount(options: Options = {}) {
  const row = options.row ?? filed;
  const get = vi.fn(async (): Promise<ApiResult<Expense>> => options.get ?? { kind: 'ok', status: 200, body: row });
  const update = vi.fn<(token: string, id: string, body: ExpensePatch) => Promise<ApiResult<Expense>>>(async () => (
    options.hold ? new Promise<ApiResult<Expense>>(() => undefined) : options.update ?? { kind: 'ok', status: 200, body: row }
  ));
  let deletes = 0;
  const remove = vi.fn(async (): Promise<ApiResult<void>> => {
    deletes += 1;
    if (options.deleteOnce) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return deletes === 1 ? { kind: 'ok', status: 204, body: undefined as void } : { kind: 'error', status: 404, message: 'Expense not found' };
    }
    return options.remove ?? { kind: 'ok', status: 204, body: undefined as void };
  });
  const image = vi.fn(async (): Promise<ApiResult<Blob>> => options.image ?? { kind: 'ok', status: 200, body: new Blob(['image']) });
  const list = vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: categories }));
  const manager = createSessionManager({ auth: createAuthApi(createClient('', async () => new Response(JSON.stringify(session()), { status: 200 }))), storage: fakeStorage() });
  await manager.signIn('someone@example.com', 'password');
  const view = render(
    <SessionProvider manager={manager}>
      <MemoryRouter initialEntries={[`/expenses/${row.id}`]}>
        <Routes>
          <Route path="/expenses/:id" element={<ExpenseDetailScreen expensesApi={{ get, update, remove }} categoriesApi={{ list }} receiptsApi={{ image }} />} />
          <Route path="/expenses" element={<Archive />} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
  return { get, update, remove, image, view };
}

async function startEditing() {
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
}

beforeEach(() => { vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:receipt'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe('expense detail', () => {
  it('shows the stored fields, omits the absent ones, and revokes the image on unmount', async () => {
    const { view, image } = await mount();
    expect(await screen.findByText('Kopitiam')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Receipt' })).toHaveAttribute('src', 'blob:receipt');
    expect(image).toHaveBeenCalledTimes(1);
    expect(screen.getByText('RM 149.30')).toBeInTheDocument();
    expect(screen.getByText('14:31')).toBeInTheDocument();
    expect(screen.getByText('R-1')).toBeInTheDocument();
    // Absent values are omitted rather than rendered as empty rows.
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument();
    expect(screen.queryByText('Note')).not.toBeInTheDocument();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:receipt');
  });

  it('sends only the field that changed', async () => {
    const { update } = await mount();
    await startEditing();
    await userEvent.clear(screen.getByLabelText('Total'));
    await userEvent.type(screen.getByLabelText('Total'), '150.00');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // The whole object would clear the merchant, the receipt number and the
    // time, because an explicit null clears a field in `createSchema.partial()`.
    expect(update.mock.calls[0]![2]).toEqual({ totalCents: 15000 });
  });

  it('nulls no other text field when one is edited', async () => {
    const { update } = await mount();
    await startEditing();
    await userEvent.clear(screen.getByLabelText('Merchant'));
    await userEvent.type(screen.getByLabelText('Merchant'), 'Warung');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // Not `receiptNumber: null`, and not `purchasedAtTime: '14:31'` either —
    // the stored `14:31:00` and the field's `14:31` are the same time.
    expect(update.mock.calls[0]![2]).toEqual({ merchantName: 'Warung' });
  });

  it('reports a rejected category as a field error rather than a missing expense', async () => {
    await mount({ update: { kind: 'error', status: 422, message: 'Category not found' } });
    await startEditing();
    await userEvent.clear(screen.getByLabelText('Total'));
    await userEvent.type(screen.getByLabelText('Total'), '12.00');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('That category is no longer available. Choose another.')).toBeInTheDocument();
    expect(screen.queryByText(/Archive/)).not.toBeInTheDocument();
  });

  it('requests no image for an expense with no receipt', async () => {
    const { image } = await mount({ row: manual });
    expect(await screen.findByText('Kopitiam')).toBeInTheDocument();
    expect(image).not.toHaveBeenCalled();
    expect(screen.queryByRole('img', { name: 'Receipt' })).not.toBeInTheDocument();
    expect(screen.queryByText('Receipt image is unavailable')).not.toBeInTheDocument();
  });

  it('renders the record when the image is unavailable', async () => {
    await mount({ image: { kind: 'error', status: 503, message: 'Receipt file is unavailable' } });
    expect(await screen.findByText('Receipt image is unavailable')).toBeInTheDocument();
    expect(screen.getByText('Kopitiam')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('returns to the archive for an id it cannot see', async () => {
    await mount({ get: { kind: 'error', status: 404, message: 'Expense not found' } });
    expect(await screen.findByText('Archive: Expense not found')).toBeInTheDocument();
  });

  it('promises the inbox only when a receipt is attached', async () => {
    const { view } = await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/The receipt goes back to your inbox\./)).toBeInTheDocument();
    view.unmount();
    await mount({ row: manual });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('This expense leaves your archive.')).toBeInTheDocument();
  });

  it('deletes only after confirming and then returns to the archive', async () => {
    const { remove } = await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();
    // Radix marks the body `pointer-events: none` while a modal is open, which
    // user-event refuses to click through.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Archive: Expense deleted.')).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one DELETE for double taps, and never reports the deleted expense as missing', async () => {
    const { remove } = await mount({ deleteOnce: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' });
    // The dialog stays open for the whole round-trip, so the second tap lands
    // on a live button. A second DELETE answers 404, and reporting that would
    // say "Expense not found" about an expense that was just deleted.
    await act(async () => { confirm.click(); confirm.click(); await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Archive: Expense deleted.')).toBeInTheDocument();
    expect(screen.queryByText(/not found/)).not.toBeInTheDocument();
  });

  it('disables the confirmation while the delete is in flight', async () => {
    // The ref covers two taps in one tick; this covers the taps a real slow
    // connection allows, seconds apart, where a render has happened between.
    const { remove } = await mount({ deleteOnce: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    expect(await screen.findByText('Archive: Expense deleted.')).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one PATCH for synchronous double taps while saving', async () => {
    const { update } = await mount({ hold: true });
    await startEditing();
    await userEvent.clear(screen.getByLabelText('Total'));
    await userEvent.type(screen.getByLabelText('Total'), '150.00');
    const save = screen.getByRole('button', { name: 'Save changes' });
    // Both clicks in one `act`, so no render happens between them: `fireEvent`
    // flushes after each event, which would let the disabled attribute answer
    // for the ref and leave the ref itself unguarded.
    await act(async () => { save.click(); save.click(); });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });
});

/**
 * AC-12. The inbox holds no client-side cache, so a receipt freed by a delete is
 * listed the next time the screen mounts rather than after a manual reload.
 * Nothing in this change caches it; this pins that it stays that way.
 */
describe('the freed receipt', () => {
  it('is listed by a freshly mounted inbox', async () => {
    const freed: Receipt = { id: 'receipt-1', contentType: 'image/jpeg', byteSize: 4, originalFilename: 'kopitiam.jpg', createdAt: '2026-08-01T06:31:00.000Z', extraction: null, expenseId: null };
    const list = vi.fn(async () => ({ kind: 'ok' as const, status: 200, body: [freed] }));
    const manager = createSessionManager({ auth: createAuthApi(createClient('', async () => new Response(JSON.stringify(session()), { status: 200 }))), storage: fakeStorage() });
    await manager.signIn('someone@example.com', 'password');
    const receiptsApi = { list, upload: vi.fn(), remove: vi.fn(), image: vi.fn() };
    const view = render(<SessionProvider manager={manager}><MemoryRouter><HomeScreen receiptsApi={receiptsApi} /></MemoryRouter></SessionProvider>);
    expect(await screen.findByText('kopitiam.jpg')).toBeInTheDocument();
    view.unmount();
    render(<SessionProvider manager={manager}><MemoryRouter><HomeScreen receiptsApi={receiptsApi} /></MemoryRouter></SessionProvider>);
    expect(await screen.findByText('kopitiam.jpg')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
