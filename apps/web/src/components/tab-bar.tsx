import { useMemo, useRef, useState } from 'react';
import { CirclePlus, LayoutDashboard, LoaderCircle, WalletCards } from 'lucide-react';
import { Link } from 'react-router';
import { createClient } from '@/api/client';
import { createReceiptsApi } from '@/api/receipts';
import { describeFailure } from '@/api/messages';
import { useSession } from '@/session/context';
import { CLIENT_ROUTES } from '@/client-routes';
import { cn } from '@/lib/utils';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const tabs = [{ to: CLIENT_ROUTES.home, label: 'Overview', icon: LayoutDashboard }, { to: CLIENT_ROUTES.expenses, label: 'Expenses', icon: WalletCards }];

export function TabBar({ active, capture = true }: { active: 'overview' | 'expenses' | 'inbox'; capture?: boolean }) {
  const { session } = useSession();
  const api = useMemo(() => createReceiptsApi(createClient('', (url, init) => fetch(url, init))), []);
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string>();
  const [uploading, setUploading] = useState(false);
  async function choose(file: File) {
    setNotice(undefined);
    if (file.size > MAX_BYTES) { setNotice('That photo is larger than 10 MB.'); return; }
    if (file.type !== '' && !ALLOWED_TYPES.has(file.type.toLowerCase())) { setNotice('Must be a JPEG, PNG, WebP or HEIC image.'); return; }
    setUploading(true);
    const result = await session.authorized((token) => api.upload(token, file));
    setUploading(false);
    if (result.kind === 'ok') {
      const unread = result.body.extraction === null || result.body.extraction.status === 'failed' || result.body.extraction.status === 'skipped';
      setNotice(result.status === 200 ? (result.body.expenseId === null ? 'You already have this receipt.' : "You already have this receipt — it's already filed.") : unread ? "Saved. We couldn't read this one — you'll fill in the details yourself." : 'Saved');
      window.dispatchEvent(new Event('receipt-uploaded'));
    } else if (!(result.kind === 'error' && result.status === 401)) {
      if (result.kind === 'offline') setNotice('Could not reach the server. Check your connection.');
      else if (result.kind === 'error' && result.status === 429) setNotice(result.retryAfterSeconds === undefined ? 'Too many uploads. Please wait a moment and try again.' : `Too many uploads. Try again in ${result.retryAfterSeconds} ${result.retryAfterSeconds === 1 ? 'second' : 'seconds'}.`);
      else setNotice(describeFailure(result));
    }
  }
  return <><p className="fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-xl text-center text-sm" role={notice ? 'alert' : undefined} aria-live="polite">{uploading ? <span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />Reading your receipt…</span> : notice}</p><nav aria-label="Main navigation" className="fixed inset-x-0 bottom-0 z-30 h-[calc(4rem+env(safe-area-inset-bottom))] border-t bg-background/95 px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur dark:border-border"><div className="relative mx-auto grid max-w-xl grid-cols-2 gap-2">{tabs.map(({ to, label, icon: Icon }) => { const isActive = (active === 'overview' || active === 'inbox') ? to === CLIENT_ROUTES.home : to === CLIENT_ROUTES.expenses; return <Link key={to} to={to} aria-current={isActive ? 'page' : undefined} className={cn('flex min-h-11 items-center justify-center gap-2 rounded-lg text-sm font-medium', isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted dark:hover:bg-muted/70')}><Icon className="size-4" aria-hidden="true" />{label}</Link>; })}{capture && <label className="absolute left-1/2 top-0 flex size-14 -translate-x-1/2 -translate-y-5 cursor-pointer items-center justify-center rounded-full border-4 border-background bg-primary text-primary-foreground shadow-lg focus-within:ring-3 focus-within:ring-ring/50" aria-label="Add receipt"><CirclePlus className="size-7" aria-hidden="true" /><input ref={input} className="sr-only" type="file" accept="image/*" onClick={(event) => { event.currentTarget.value = ''; }} onChange={(event) => { const file = event.target.files?.[0]; if (file) void choose(file); }} /></label>}</div></nav></>;
}
