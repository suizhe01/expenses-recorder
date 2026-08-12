import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, ReceiptText, Trash2, Upload } from 'lucide-react';
import { Link } from 'react-router';
import { CLIENT_ROUTES, confirmReceiptPath } from '@/client-routes';
import { createClient } from '@/api/client';
import { createReceiptsApi, type Receipt, type ReceiptsApi } from '@/api/receipts';
import { describeFailure } from '@/api/messages';
import { useSession } from '@/session/context';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { TabBar } from '@/components/tab-bar';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const OFFLINE = 'Could not reach the server. Check your connection.';

export function formatPurchasedOn(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[month! - 1]} ${year}`;
}

export function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(value)).replace(/\b(am|pm)\b/i, (period) => period.toLowerCase());
}

export function formatMoney(cents: number, currency: string | null): string {
  const code = currency ?? 'MYR';
  const label = code === 'MYR' ? 'RM' : code;
  return `${label} ${(cents / 100).toFixed(2)}`;
}

type Notice = { text: string; alert: boolean; offline?: boolean };

export function HomeScreen({ receiptsApi }: { receiptsApi?: ReceiptsApi } = {}) {
  const { session } = useSession();
  const defaultApi = useMemo(() => createReceiptsApi(createClient('', (url, init) => fetch(url, init))), []);
  const api = receiptsApi ?? defaultApi;
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string>();
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [newId, setNewId] = useState<string>();
  const [deleting, setDeleting] = useState<Receipt>();
  const [deleteError, setDeleteError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const returnNotice = (window.history.state as { usr?: { notice?: unknown } } | null)?.usr?.notice;

  useEffect(() => {
    let cancelled = false;
    void session.authorized((token) => api.list(token)).then((result) => {
      if (cancelled) return;
      if (result.kind === 'ok') {
        setReceipts(result.body.filter((receipt) => receipt.expenseId === null).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      } else if (!(result.kind === 'error' && result.status === 401)) {
        setListError(describeFailure(result));
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, session]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function choose(next: File) {
    setNotice(undefined);
    if (next.size > MAX_BYTES) {
      setNotice({ text: 'That photo is larger than 10 MB.', alert: true });
      return;
    }
    if (next.type !== '' && !ALLOWED_TYPES.has(next.type.toLowerCase())) {
      setNotice({ text: 'Must be a JPEG, PNG, WebP or HEIC image.', alert: true });
      return;
    }
    setFile(next);
    setPreview(URL.createObjectURL(next));
    void upload(next);
  }

  async function upload(next: File) {
    setUploading(true);
    setNotice(undefined);
    const result = await session.authorized((token) => api.upload(token, next));
    setUploading(false);
    if (result.kind === 'offline') {
      setNotice({ text: OFFLINE, alert: true, offline: true });
      return;
    }
    if (result.kind === 'error') {
      if (result.status === 401) return;
      if (result.status === 429) {
        const wait = result.retryAfterSeconds;
        setNotice({ text: wait === undefined ? 'Too many uploads. Please wait a moment and try again.' : `Too many uploads. Try again in ${wait} ${wait === 1 ? 'second' : 'seconds'}.`, alert: true });
      } else {
        setNotice({ text: describeFailure(result), alert: true });
      }
      return;
    }
    const receipt = result.body;
    if (result.status === 200) {
      setNotice({ text: receipt.expenseId === null ? 'You already have this receipt.' : "You already have this receipt — it's already filed.", alert: false });
      return;
    }
    if (receipt.expenseId === null) {
      setReceipts((current) => [receipt, ...current.filter((item) => item.id !== receipt.id)]);
      setNewId(receipt.id);
      window.setTimeout(() => setNewId(undefined), 700);
    }
    const unread = receipt.extraction === null || receipt.extraction.status === 'failed' || receipt.extraction.status === 'skipped';
    setNotice({ text: unread ? "Saved. We couldn't read this one — you'll fill in the details yourself." : 'Saved', alert: false });
  }

  function discard() {
    setFile(undefined);
    setPreview(undefined);
    setNotice(undefined);
    if (input.current) input.current.value = '';
  }

  async function remove() {
    if (!deleting) return;
    setDeleteError(undefined);
    const result = await session.authorized((token) => api.remove(token, deleting.id));
    if (result.kind === 'ok') {
      setReceipts((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(undefined);
    } else if (result.kind === 'error' && result.status === 409) {
      setDeleteError('This receipt is attached to an expense. Delete the expense first.');
    } else if (!(result.kind === 'error' && result.status === 401)) {
      setDeleteError(describeFailure(result));
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col overflow-x-hidden px-4 pb-36">
      <header className="flex min-w-0 items-center justify-between gap-3 border-b py-4 dark:border-border">
        <div className="min-w-0"><h1 className="font-heading text-lg font-semibold">Receipts</h1><p className="truncate text-sm text-muted-foreground">Waiting to be filed</p></div>
        <Button asChild variant="outline" className="h-11"><Link to={CLIENT_ROUTES.settings}>Settings</Link></Button>
      </header>

      <section className="py-5" aria-labelledby="inbox-heading">
        <h2 id="inbox-heading" className="mb-3 text-sm font-medium text-muted-foreground">Waiting to be filed</h2>
        {typeof returnNotice === 'string' && <Alert className="mb-3"><AlertDescription>{returnNotice}</AlertDescription></Alert>}
        {listError && <Alert variant="destructive"><AlertDescription>{listError}</AlertDescription></Alert>}
        {loading ? <div className="grid gap-2" aria-label="Loading receipts">{[1,2,3].map((n) => <Skeleton key={n} className="h-20 w-full" />)}</div> : receipts.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground dark:border-border"><ReceiptText className="mx-auto mb-3 size-6" aria-hidden="true" />No receipts waiting. Snap one to get started.</div>
        ) : <div className="grid gap-2">{receipts.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} fresh={receipt.id === newId} onDelete={() => setDeleting(receipt)} />)}</div>}
      </section>

      <section className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 px-4 pb-3">
        <div className="mx-auto grid h-32 w-full max-w-xl grid-cols-[5rem_1fr] items-center gap-3 rounded-xl border bg-card p-3 shadow-sm dark:border-border">
          {preview ? <img src={preview} alt="Selected receipt preview" className="h-24 w-20 rounded-lg object-cover" /> : <div className="flex h-24 w-20 items-center justify-center rounded-lg bg-muted dark:bg-muted/70"><Upload aria-hidden="true" /></div>}
          <div aria-live="polite" className="min-w-0">
            {uploading ? <p className="flex items-center gap-2 text-sm font-medium"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Reading your receipt…</p> : notice ? <div role={notice.alert ? 'alert' : undefined}><p className={cn('line-clamp-2 text-sm', notice.alert ? 'text-destructive' : 'text-foreground')}>{notice.text}</p>{notice.offline ? <div className="mt-2 flex gap-2"><Button className="h-11" onClick={() => file && void upload(file)}>Retry</Button><Button variant="outline" className="h-11" onClick={discard}>Discard</Button></div> : <label htmlFor="receipt-file" className="mt-2 inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground focus-within:ring-3 focus-within:ring-ring/50">Add another<input ref={input} id="receipt-file" className="sr-only" type="file" accept="image/*" onClick={(event) => { event.currentTarget.value = ''; }} onChange={(event) => { const next = event.target.files?.[0]; if (next) choose(next); }} /></label>}</div> : <><label htmlFor="receipt-file" className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground focus-within:ring-3 focus-within:ring-ring/50">Add receipt<input ref={input} id="receipt-file" className="sr-only" type="file" accept="image/*" onClick={(event) => { event.currentTarget.value = ''; }} onChange={(event) => { const next = event.target.files?.[0]; if (next) choose(next); }} /></label><p className="mt-1 text-xs text-muted-foreground">JPEG, PNG, WebP or HEIC · 10 MB max</p></>}
          </div>
        </div>
      </section>
      <TabBar active="inbox" capture={false} />

      <Dialog open={deleting !== undefined} onOpenChange={(open) => { if (!open) { setDeleting(undefined); setDeleteError(undefined); } }}>
        <DialogContent><DialogHeader><DialogTitle>Delete receipt?</DialogTitle><DialogDescription>Delete this receipt? It leaves your inbox.</DialogDescription></DialogHeader>{deleteError && <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert>}<DialogFooter><DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose><Button variant="destructive" onClick={() => void remove()}>Delete</Button></DialogFooter></DialogContent>
      </Dialog>
    </main>
  );
}

function ReceiptRow({ receipt, fresh, onDelete }: { receipt: Receipt; fresh: boolean; onDelete: () => void }) {
  const read = receipt.extraction && receipt.extraction.status !== 'failed' && receipt.extraction.status !== 'skipped';
  return <article className={cn('grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border bg-card p-3 dark:border-border dark:bg-card', fresh && 'animate-[saved_600ms_ease-out] motion-reduce:animate-none')}>
    <Link className="min-h-11 min-w-0 text-left" to={confirmReceiptPath(receipt.id)}><div className="flex min-w-0 items-center gap-2"><p className={cn('truncate font-medium', !read && 'text-muted-foreground')}>{read ? receipt.extraction!.merchantName ?? receipt.originalFilename ?? 'Receipt' : receipt.originalFilename ?? 'Receipt'}</p>{!read && <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground dark:bg-muted/70">Needs details</span>}</div><p className="mt-1 truncate text-xs text-muted-foreground">{read && receipt.extraction!.purchasedOn ? formatPurchasedOn(receipt.extraction!.purchasedOn) + ' · ' : !read ? "Couldn't be read · " : ''}{formatCreatedAt(receipt.createdAt)}</p></Link>
    <div className="flex items-center gap-2">{read && receipt.extraction!.totalCents !== null && <p className="min-w-24 text-right font-medium tabular-nums">{formatMoney(receipt.extraction!.totalCents, receipt.extraction!.currency)}</p>}<Button variant="ghost" size="icon" className="size-11" aria-label={`Delete ${receipt.originalFilename ?? 'receipt'}`} onClick={onDelete}><Trash2 aria-hidden="true" /></Button></div>
  </article>;
}
