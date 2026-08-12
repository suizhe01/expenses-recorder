import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAuthApi } from '@/api/auth';
import { createClient } from '@/api/client';
import { createReceiptsApi, type Receipt } from '@/api/receipts';
import { HomeScreen, formatCreatedAt, formatMoney, formatPurchasedOn } from '@/routes/home';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, fakeTransport, session } from '@/test/support';

const created: Receipt = {
  id: 'receipt-1', contentType: 'image/jpeg', byteSize: 4,
  originalFilename: 'lunch.jpg', createdAt: '2026-08-11T07:42:00.000Z', expenseId: null,
  extraction: { status: 'succeeded', merchantName: 'Corner Cafe', purchasedOn: '2026-08-08', totalCents: 2685, currency: null },
};

async function mount(routes: Parameters<typeof fakeTransport>[0]) {
  const http = fakeTransport({ '/auth/refresh': { status: 200, body: session() }, ...routes });
  const manager = createSessionManager({ auth: createAuthApi(createClient('', http.transport)), storage: fakeStorage() });
  await manager.signIn('someone@example.com', 'password');
  render(<SessionProvider manager={manager}><HomeScreen receiptsApi={createReceiptsApi(createClient('', http.transport))} /></SessionProvider>);
  return http;
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('receipt inbox', () => {
  it('positions capture above the safe-area-aware tab bar', async () => {
    await mount({ '/receipts': { status: 200, body: [] } });
    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(document.querySelector('section.fixed')).toHaveClass('bottom-[calc(4rem+env(safe-area-inset-bottom))]');
  });
  it('renders extracted data and the empty-safe date without Date parsing', async () => {
    await mount({ '/auth/login': { status: 200, body: session() }, '/receipts': { status: 200, body: [created] } });
    expect(await screen.findByText('Corner Cafe')).toBeInTheDocument();
    expect(screen.getByText('RM 26.85')).toHaveClass('tabular-nums');
    expect(screen.getByText(/8 Aug 2026/)).toBeInTheDocument();
    expect(formatMoney(2685, null)).toBe('RM 26.85');
    expect(formatPurchasedOn('2026-08-08')).toBe('8 Aug 2026');
    expect(formatCreatedAt('2026-08-11T07:42:00.000Z')).toMatch(/^11 Aug, \d{1,2}:42 (am|pm)$/);
  });

  it('rejects oversized and wrong-type files without a request', async () => {
    const http = await mount({ '/auth/login': { status: 200, body: session() }, '/receipts': { status: 200, body: [] } });
    let picker = await screen.findByLabelText('Add receipt');
    await userEvent.upload(picker, new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.jpg', { type: 'image/jpeg' }));
    expect(screen.getByText('That photo is larger than 10 MB.').parentElement).toHaveAttribute('role', 'alert');
    picker = screen.getByLabelText('Add another');
    await userEvent.upload(picker, new File(['text'], 'notes.txt', { type: 'text/plain' }), { applyAccept: false });
    expect(screen.getByText('Must be a JPEG, PNG, WebP or HEIC image.')).toBeInTheDocument();
    expect(http.countOf('/receipts')).toBe(1);
  });

  it('adds a 201 result without refetching and keeps failed extraction neutral', async () => {
    const unread = { ...created, extraction: { ...created.extraction!, status: 'failed' } };
    const http = await mount({ '/auth/login': { status: 200, body: session() }, '/receipts': [{ status: 200, body: [] }, { status: 201, body: unread }] });
    await userEvent.upload(await screen.findByLabelText('Add receipt'), new File(['jpeg'], 'lunch.jpg', { type: 'image/jpeg' }));
    const note = await screen.findByText("Saved. We couldn't read this one — you'll fill in the details yourself.");
    expect(note.parentElement).not.toHaveAttribute('role', 'alert');
    expect(screen.getByText('Needs details')).toBeInTheDocument();
    expect(http.countOf('/receipts')).toBe(2);
  });

  it.each([
    [null, 'You already have this receipt.'],
    ['expense-1', "You already have this receipt — it's already filed."],
  ])('distinguishes duplicate state', async (expenseId, message) => {
    await mount({ '/auth/login': { status: 200, body: session() }, '/receipts': [{ status: 200, body: [] }, { status: 200, body: { ...created, expenseId } }] });
    await userEvent.upload(await screen.findByLabelText('Add receipt'), new File(['jpeg'], 'lunch.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('holds an offline file for retry and revokes its object URL on unmount', async () => {
    const http = fakeTransport({ '/auth/login': { status: 200, body: session() }, '/auth/refresh': { status: 200, body: session() }, '/receipts': { status: 200, body: [] } });
    let uploads = 0;
    const transport = async (url: string, init: RequestInit) => {
      if (url === '/receipts' && init.method === 'POST' && uploads++ === 0) throw new TypeError('offline');
      return http.transport(url, init);
    };
    const manager = createSessionManager({ auth: createAuthApi(createClient('', transport)), storage: fakeStorage() });
    await manager.signIn('someone@example.com', 'password');
    const view = render(<SessionProvider manager={manager}><HomeScreen receiptsApi={createReceiptsApi(createClient('', transport))} /></SessionProvider>);
    await userEvent.upload(await screen.findByLabelText('Add receipt'), new File(['jpeg'], 'lunch.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText('Could not reach the server. Check your connection.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText("You already have this receipt — it's already filed.");
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('confirms and removes a receipt', async () => {
    const http = await mount({ '/auth/login': { status: 200, body: session() }, '/receipts': { status: 200, body: [created] }, '/receipts/receipt-1': { status: 204 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete lunch.jpg' }));
    expect(screen.getByText('Delete this receipt? It leaves your inbox.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Corner Cafe')).not.toBeInTheDocument());
    expect(http.countOf('/receipts/receipt-1')).toBe(1);
  });
});
