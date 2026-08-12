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

const receipt = { id: 'receipt-1', contentType: 'image/jpeg', byteSize: 4, originalFilename: 'DAY ONE', createdAt: '2026-08-12T00:00:00Z', expenseId: null, extraction: { status: 'failed', isReceipt: false, merchantName: null, purchasedOn: null, totalCents: null, currency: null } };
const category = { id: '00000000-0000-0000-0000-000000000002', name: 'Food', createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z' };

async function mount(fileStatus = 503, expense: { status: number; body: unknown } = { status: 201, body: { id: 'expense-1' } }, holdExpense = false) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://test.local').pathname; calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/receipts') return new Response(JSON.stringify([receipt]), { status: 200 });
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
});
