import { useEffect, useMemo, useState } from 'react';
import { Download, Filter, Search, X } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { createClient } from '@/api/client';
import { createExpensesApi, type Expense, type ExpenseFilters, type ExpensesApi } from '@/api/expenses';
import { createCategoriesApi, type Category } from '@/api/categories';
import { createExportsApi, type ExportsApi } from '@/api/exports';
import { downloadCsv, startZipDownload } from '@/export/download';
import { describeFailure } from '@/api/messages';
import { TabBar } from '@/components/tab-bar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/session/context';
import { expenseDetailPath } from '@/client-routes';
import { CategoryIcon } from '@/components/category-icon';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthKey(purchasedOn: string): string { return purchasedOn.slice(0, 7); }
export function monthLabel(key: string): string { const [year, month] = key.split('-'); return `${MONTHS[Number(month) - 1] ?? ''} ${year}`; }
export function dayOfMonth(purchasedOn: string): string { return purchasedOn.slice(8, 10); }
export function formatMoney(cents: number, currency: string): string { return `${currency === 'MYR' ? 'RM' : currency} ${(cents / 100).toFixed(2)}`; }

export function groupExpenses(expenses: Expense[]): { month: string; expenses: Expense[]; totals: Map<string, number> }[] {
  const groups = new Map<string, Expense[]>();
  expenses.forEach((expense) => {
    const key = monthKey(expense.purchasedOn);
    groups.set(key, [...(groups.get(key) ?? []), expense]);
  });
  return [...groups.entries()].map(([month, rows]) => ({ month, expenses: rows, totals: rows.reduce((totals, row) => totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.totalCents), new Map<string, number>()) }));
}

function filtersFromSearch(search: URLSearchParams): ExpenseFilters {
  const hasReceipt = search.get('hasReceipt');
  return { ...(search.get('from') ? { from: search.get('from')! } : {}), ...(search.get('to') ? { to: search.get('to')! } : {}), ...(search.getAll('categoryId').length ? { categoryId: search.getAll('categoryId') } : {}), ...(hasReceipt === 'true' || hasReceipt === 'false' ? { hasReceipt: hasReceipt === 'true' } : {}) };
}

function filterCount(filters: ExpenseFilters): number { return Number(Boolean(filters.from)) + Number(Boolean(filters.to)) + (filters.categoryId?.length ?? 0) + Number(filters.hasReceipt !== undefined); }

export function ExpensesScreen({ expensesApi, categoriesApi, exportsApi, csvDownload = downloadCsv, zipNavigate = (url: string) => window.location.assign(url) }: { expensesApi?: Pick<ExpensesApi, 'list'>; categoriesApi?: Pick<ReturnType<typeof createCategoriesApi>, 'list'>; exportsApi?: ExportsApi; csvDownload?: typeof downloadCsv; zipNavigate?: (url: string) => void } = {}) {
  const { session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultExpenses = useMemo(() => createExpensesApi(createClient('', (url, init) => fetch(url, init))), []);
  const defaultCategories = useMemo(() => createCategoriesApi(createClient('', (url, init) => fetch(url, init))), []);
  const defaultExports = useMemo(() => createExportsApi(createClient('', (url, init) => fetch(url, init))), []);
  const api = expensesApi ?? defaultExpenses;
  const categoryApi = categoriesApi ?? defaultCategories;
  const exportApi = exportsApi ?? defaultExports;
  const filters = filtersFromSearch(searchParams);
  const filterKey = `${filters.from ?? ''}|${filters.to ?? ''}|${filters.categoryId?.join(',') ?? ''}|${filters.hasReceipt ?? ''}`;
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [deletedCategoryNotice, setDeletedCategoryNotice] = useState(false);
  const [search, setSearch] = useState('');
  // EXP-31 AC-8, AC-10. What the detail screen said on its way back here.
  const returnNotice = (useLocation().state as { notice?: unknown } | null)?.notice;

  useEffect(() => {
    let cancelled = false;
    // A changed URL is a new remote resource: show its skeleton before the
    // request begins rather than retaining rows from the previous filter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(undefined);
    void session.authorized((token) => api.list(token, filters)).then((result) => {
      if (cancelled) return;
      if (result.kind === 'ok') setExpenses(result.body);
      else if (result.kind === 'error' && result.status === 422 && filters.categoryId?.length) {
        setDeletedCategoryNotice(true);
        setSearchParams((current) => {
          const next = new URLSearchParams(current);
          // The API does not identify which repeated category id was deleted,
          // so remove the category filter while retaining every other filter.
          next.delete('categoryId');
          return next;
        }, { replace: true });
      }
      else if (!(result.kind === 'error' && result.status === 401)) setError(describeFailure(result));
      setLoading(false);
    });
    return () => { cancelled = true; };
  // `filterKey` is deliberately the stable representation of the URL filters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filterKey, session, setSearchParams]);

  useEffect(() => { void session.authorized((token) => categoryApi.list(token)).then((result) => { if (result.kind === 'ok') setCategories(result.body); }); }, [categoryApi, session]);

  const visible = expenses.filter((expense) => `${expense.merchantName ?? ''} ${expense.note ?? ''} ${expense.receiptNumber ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const active = filterCount(filters);
  const filtered = active > 0 || search.trim() !== '';
  function clearAll() { setSearch(''); setSearchParams({}); }

  return <main className="mx-auto min-h-dvh w-full max-w-xl overflow-x-hidden px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
    <header className="border-b py-4 dark:border-border"><h1 className="font-heading text-lg font-semibold">Expenses</h1><p className="text-sm text-muted-foreground">Your filed expense archive</p></header>
    <div className="flex gap-2 py-4"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input aria-label="Search expenses" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search merchant, note or receipt" /></div><Filters filters={filters} categories={categories} count={active} onApply={(next) => setSearchParams(toSearch(next))} /><Export filters={filters} categories={categories} count={expenses.length} searchActive={search.trim() !== ''} api={exportApi} authorized={session.authorized} csvDownload={csvDownload} zipNavigate={zipNavigate} /></div>
    {typeof returnNotice === 'string' && <Alert className="mb-3"><AlertDescription>{returnNotice}</AlertDescription></Alert>}
    {error && <Alert variant="destructive" role="alert" className="mb-3"><AlertDescription>{error}</AlertDescription></Alert>}
    {deletedCategoryNotice && <Alert variant="destructive" role="alert" className="mb-3"><AlertDescription>That category was deleted</AlertDescription></Alert>}
    <p className="sr-only" aria-live="polite">{loading ? 'Loading expenses' : `${visible.length} ${visible.length === 1 ? 'expense' : 'expenses'} shown`}</p>
    {loading ? <ExpenseSkeletons /> : expenses.length === 0 && !filtered ? <Empty title="Nothing filed yet" /> : visible.length === 0 ? <Empty title="No expenses match" clear={clearAll} /> : <div className="grid gap-5">{groupExpenses(visible).map((group) => <section key={group.month}><header className="sticky top-0 z-10 -mx-4 flex items-start justify-between border-y bg-muted px-4 py-2 backdrop-blur dark:border-border dark:bg-muted/70"><h2 className="font-medium">{monthLabel(group.month)}</h2><div className="text-right font-medium tabular-nums">{[...group.totals.entries()].map(([currency, cents]) => <p key={currency}>{formatMoney(cents, currency)}</p>)}</div></header><div>{group.expenses.map((expense) => <ExpenseRow key={expense.id} expense={expense} />)}</div></section>)}</div>}
    <TabBar active="expenses" />
  </main>;
}

function toSearch(filters: ExpenseFilters): URLSearchParams { const result = new URLSearchParams(); if (filters.from) result.set('from', filters.from); if (filters.to) result.set('to', filters.to); filters.categoryId?.forEach((id) => result.append('categoryId', id)); if (filters.hasReceipt !== undefined) result.set('hasReceipt', String(filters.hasReceipt)); return result; }

function Filters({ filters, categories, count, onApply }: { filters: ExpenseFilters; categories: Category[]; count: number; onApply: (filters: ExpenseFilters) => void }) {
  const [draft, setDraft] = useState(filters);
  return <Sheet onOpenChange={(open) => { if (open) setDraft(filters); }}><SheetTrigger asChild><Button variant="outline" className="h-11 shrink-0"><Filter aria-hidden="true" />Filters{count ? ` (${count})` : ''}</Button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>Filter expenses</SheetTitle><SheetDescription>Filters update the archived expense list.</SheetDescription></SheetHeader><div className="grid gap-4"><label className="grid gap-1 text-sm font-medium">From<Input type="date" value={draft.from ?? ''} onChange={(event) => setDraft({ ...draft, from: event.target.value || undefined })} /></label><label className="grid gap-1 text-sm font-medium">To<Input type="date" value={draft.to ?? ''} onChange={(event) => setDraft({ ...draft, to: event.target.value || undefined })} /></label><fieldset><legend className="mb-2 text-sm font-medium">Categories</legend><div className="grid gap-2">{categories.map((category) => <label key={category.id} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={draft.categoryId?.includes(category.id) ?? false} onChange={(event) => setDraft({ ...draft, categoryId: event.target.checked ? [...(draft.categoryId ?? []), category.id] : draft.categoryId?.filter((id) => id !== category.id) })} /><CategoryIcon name={category.name} className="size-4 shrink-0 text-muted-foreground" />{category.name}</label>)}</div></fieldset><fieldset><legend className="mb-2 text-sm font-medium">Receipt</legend><select aria-label="Receipt filter" className="h-11 w-full rounded-lg border bg-transparent px-2.5 text-base" value={draft.hasReceipt === undefined ? '' : String(draft.hasReceipt)} onChange={(event) => setDraft({ ...draft, hasReceipt: event.target.value === '' ? undefined : event.target.value === 'true' })}><option value="">Any receipt status</option><option value="true">Has receipt</option><option value="false">No receipt</option></select></fieldset></div><SheetFooter><Button variant="outline" onClick={() => { setDraft({}); onApply({}); }}>Clear all</Button><SheetClose asChild><Button onClick={() => onApply(draft)}>Apply filters</Button></SheetClose></SheetFooter></SheetContent></Sheet>;
}

function filterSummary(filters: ExpenseFilters, categories: Category[]): string {
  const parts: string[] = [];
  if (filters.from || filters.to) parts.push(`dates ${filters.from ?? 'the beginning'} to ${filters.to ?? 'today'}`);
  if (filters.categoryId?.length) parts.push(`categories ${filters.categoryId.map((id) => categories.find((category) => category.id === id)?.name ?? 'selected').join(', ')}`);
  if (filters.hasReceipt !== undefined) parts.push(filters.hasReceipt ? 'expenses with receipts' : 'expenses without receipts');
  return parts.length ? parts.join('; ') : 'all expenses';
}

function Export({ filters, categories, count, searchActive, api, authorized, csvDownload, zipNavigate }: { filters: ExpenseFilters; categories: Category[]; count: number; searchActive: boolean; api: ExportsApi; authorized: ReturnType<typeof useSession>['session']['authorized']; csvDownload: typeof downloadCsv; zipNavigate: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<'csv' | 'zip'>();
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>();
  const summary = filterSummary(filters, categories);
  async function csv() {
    if (running) return;
    setRunning('csv'); setError(undefined); setFields({}); setNotice(undefined);
    const tokenResult = await authorized((token) => Promise.resolve({ kind: 'ok' as const, status: 200, body: token }));
    if (tokenResult.kind !== 'ok') { setRunning(undefined); setError('Could not start the download. Please try again.'); return; }
    const result = await csvDownload(tokenResult.body, filters);
    setRunning(undefined);
    if (!result.ok) {
      setError(result.status === 400 || result.status === 422 ? result.message : 'Could not start the download. Please try again.');
      setFields(result.fields ?? {});
      return;
    }
    setNotice("Download started. Check your browser's downloads.");
  }
  async function zip() {
    if (running) return;
    setRunning('zip'); setError(undefined); setFields({}); setNotice(undefined);
    const minted = await authorized((token) => api.createToken(token));
    setRunning(undefined);
    if (minted.kind !== 'ok') { setError('Could not start the download. Please try again.'); return; }
    startZipDownload(minted.body.token, filters, zipNavigate);
    setNotice("Download started. Check your browser's downloads.");
  }
  return <Sheet open={open} onOpenChange={setOpen}><SheetTrigger asChild><Button variant="outline" className="h-11 shrink-0" aria-label="Export expenses"><Download aria-hidden="true" />Export</Button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>Export expenses</SheetTitle><SheetDescription>This export includes {summary}: {count} {count === 1 ? 'expense' : 'expenses'} currently visible from those filters.</SheetDescription></SheetHeader><div className="grid gap-3"><p className="text-sm text-muted-foreground">{searchActive ? 'Search text is not applied. The export covers the filters, not the search box.' : 'The export covers the active filters. Search text is never applied.'}</p>{count === 0 && <p className="text-sm text-muted-foreground">No expenses match these filters, but you can still export a header-only file.</p>}{error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription>{Object.entries(fields).map(([field, message]) => <p key={field} className="mt-1 text-sm">{field}: {message}</p>)}</Alert>}{notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}<Button className="h-11" disabled={running !== undefined} onClick={() => void csv()}>{running === 'csv' ? 'Starting CSV…' : 'Download CSV'}</Button><div className="rounded-xl border p-3 dark:border-border"><p className="font-medium">ZIP with receipt images</p><p className="mt-1 text-sm text-muted-foreground">Includes receipt images plus expenses.csv. This can be a large download.</p><Button variant="outline" className="mt-3 h-11 w-full" disabled={running !== undefined} onClick={() => void zip()}>{running === 'zip' ? 'Starting ZIP…' : 'Download ZIP'}</Button></div></div></SheetContent></Sheet>;
}

// EXP-31 AC-1. The whole row is the link, matching the inbox row's anatomy.
function ExpenseRow({ expense }: { expense: Expense }) { return <article className="border-b dark:border-border"><Link to={expenseDetailPath(expense.id)} className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3"><div className="min-w-0"><p className="truncate font-medium">{expense.merchantName ?? 'No merchant'}</p><p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground"><CategoryIcon name={expense.category.name} className="size-3.5 shrink-0" /><span className="truncate">{expense.category.name} · {dayOfMonth(expense.purchasedOn)}</span></p></div><p className="text-right font-medium tabular-nums">{formatMoney(expense.totalCents, expense.currency)}</p></Link></article>; }
function ExpenseSkeletons() { return <div className="grid gap-2" aria-label="Loading expenses">{[1, 2, 3, 4].map((n) => <div key={n} className="grid min-h-16 grid-cols-[1fr_auto] items-center gap-3 border-b py-3 dark:border-border"><div className="grid gap-2"><Skeleton className="h-4 w-36" /><Skeleton className="h-3 w-20" /></div><Skeleton className="h-4 w-16" /></div>)}</div>; }
function Empty({ title, clear }: { title: string; clear?: () => void }) { return <div className="rounded-xl border border-dashed p-8 text-center dark:border-border"><p className="font-medium">{title}</p>{clear && <Button variant="link" className="mt-2" onClick={clear}><X aria-hidden="true" />Clear all</Button>}</div>; }
