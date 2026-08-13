import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { createClient } from '@/api/client';
import { createCategoriesApi, type CategoriesApi, type Category } from '@/api/categories';
import { createExpensesApi, type Expense, type ExpensesApi } from '@/api/expenses';
import { createReceiptsApi, type ReceiptsApi } from '@/api/receipts';
import { describeFailure } from '@/api/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { COLLAPSED_KEYS, ExpenseForm, changedFields, fieldsFromExpense, validateExpense, type ExpenseFields } from '@/components/expense-form';
import { useSession } from '@/session/context';
import { formatMoney } from '@/routes/expenses';
import { formatPurchasedOn } from '@/routes/home';
import { CLIENT_ROUTES } from '@/client-routes';
import { CategoryIcon } from '@/components/category-icon';

const NOT_FOUND = 'Expense not found';
const transport = (url: string, init: RequestInit) => fetch(url, init);

/**
 * EXP-31. One filed expense: every stored field, its receipt image, an edit mode
 * and delete.
 */
export function ExpenseDetailScreen({ expensesApi, categoriesApi, receiptsApi }: { expensesApi?: Pick<ExpensesApi, 'get' | 'update' | 'remove'>; categoriesApi?: Pick<CategoriesApi, 'list'>; receiptsApi?: Pick<ReceiptsApi, 'image'> } = {}) {
  const { expenseId: id = '' } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const request = useMemo(() => createClient('', transport), []);
  const api = useMemo(() => expensesApi ?? createExpensesApi(request), [expensesApi, request]);
  const categoryApi = useMemo(() => categoriesApi ?? createCategoriesApi(request), [categoriesApi, request]);
  const receipts = useMemo(() => receiptsApi ?? createReceiptsApi(request), [receiptsApi, request]);

  const [expense, setExpense] = useState<Expense>();
  const [categories, setCategories] = useState<Category[]>([]);
  // AC-6. `initial` is what the server last confirmed; the patch is the
  // difference between it and `fields`, never `fields` itself.
  const [initial, setInitial] = useState<ExpenseFields>();
  const [fields, setFields] = useState<ExpenseFields>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [image, setImage] = useState<string>();
  const [imageUnavailable, setImageUnavailable] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [fatal, setFatal] = useState<string>();

  function leave(text: string) { navigate(CLIENT_ROUTES.expenses, { replace: true, state: { notice: text } }); }

  async function loadCategories() {
    const result = await session.authorized((token) => categoryApi.list(token));
    if (result.kind === 'ok') setCategories(result.body);
  }

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    // The record and its category list are this route's one-time load; nothing
    // is set before both requests are in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void Promise.all([session.authorized((token) => api.get(token, id)), loadCategories()]).then(async ([result]) => {
      if (cancelled) return;
      // AC-8. Unknown, another account's, and already deleted are one answer.
      if (result.kind === 'error' && result.status === 404) { leave(NOT_FOUND); return; }
      if (result.kind !== 'ok') { if (!(result.kind === 'error' && result.status === 401)) setFatal(describeFailure(result)); return; }
      setExpense(result.body);
      setFields(fieldsFromExpense(result.body));
      setInitial(fieldsFromExpense(result.body));
      // AC-4. A manual entry has no receipt, so no image is requested at all.
      if (result.body.receiptId === null) return;
      const file = await session.authorized((token) => receipts.image(token, result.body.receiptId!));
      if (cancelled) return;
      if (file.kind === 'ok') { objectUrl = URL.createObjectURL(file.body); setImage(objectUrl); }
      // AC-3. A missing image never blocks the record it belongs to.
      else if (!(file.kind === 'error' && file.status === 401)) setImageUnavailable(true);
    });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  // The APIs are stable memoized values and `loadCategories` belongs to this
  // one-time route load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id, navigate, receipts, session]);

  function change(name: keyof ExpenseFields, value: string) {
    setFields((current) => (current ? { ...current, [name]: value } : current));
    setErrors((current) => { const next = { ...current }; delete next[name]; return next; });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    // AC-9. There is no idempotency key, so the guard is a ref rather than
    // state: two taps in one tick both read the same stale `saving`.
    if (savingRef.current || !fields || !initial) return;
    const checked = validateExpense(fields);
    setErrors(checked.errors);
    if (!checked.values) return;
    savingRef.current = true;
    setSaving(true);
    const result = await session.authorized((token) => api.update(token, id, changedFields(initial, fields, checked.values!)));
    savingRef.current = false;
    setSaving(false);
    if (result.kind === 'ok') {
      setExpense(result.body);
      setFields(fieldsFromExpense(result.body));
      setInitial(fieldsFromExpense(result.body));
      setEditing(false);
      setNotice('Changes saved.');
      return;
    }
    if (result.kind === 'error' && result.status === 400 && result.fields) {
      setErrors(result.fields);
      if (Object.keys(result.fields).some((key) => COLLAPSED_KEYS.has(key))) setExpanded(true);
      return;
    }
    // AC-7. `badReference` runs before the row lookup, so a bad category answers
    // 422 even for an unknown id. Reporting that as a missing expense would send
    // the user looking for the wrong problem.
    if (result.kind === 'error' && result.status === 422 && result.message === 'Category not found') {
      await loadCategories();
      setErrors({ categoryId: 'That category is no longer available. Choose another.' });
      return;
    }
    if (result.kind === 'error' && result.status === 404) { leave(NOT_FOUND); return; }
    if (!(result.kind === 'error' && result.status === 401)) setErrors({ form: describeFailure(result) });
  }

  async function remove() {
    // The same guard `save` carries, and for a sharper reason: the dialog stays
    // open for the whole round-trip, so a second tap sends a second DELETE. The
    // row is already gone by then, so it answers 404 — and reporting that would
    // tell someone their expense was not found immediately after deleting it.
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(undefined);
    const result = await session.authorized((token) => api.remove(token, id));
    if (result.kind === 'ok') { leave('Expense deleted.'); return; }
    deletingRef.current = false;
    setDeleting(false);
    if (result.kind === 'error' && result.status === 404) { leave(NOT_FOUND); return; }
    if (!(result.kind === 'error' && result.status === 401)) setDeleteError(describeFailure(result));
  }

  if (fatal) return <main className="mx-auto max-w-xl p-4"><Alert variant="destructive" role="alert"><AlertDescription>{fatal}</AlertDescription></Alert></main>;
  if (!expense || !fields) return <main className="flex min-h-dvh items-center justify-center" aria-busy="true">Loading…</main>;

  return <main className="mx-auto min-h-dvh w-full max-w-xl overflow-x-hidden px-4 pb-28">
    <header className="flex items-center gap-2 py-3">
      <Button type="button" variant="ghost" size="icon" className="size-11" onClick={() => navigate(CLIENT_ROUTES.expenses)} aria-label="Back"><ChevronLeft /></Button>
      <h1 className="font-heading text-lg font-semibold">{editing ? 'Edit expense' : 'Expense'}</h1>
    </header>

    {image ? <button type="button" className="mb-5 block min-h-44 w-full overflow-hidden rounded-xl bg-muted" onClick={() => setPreview(true)}><img className="max-h-80 w-full object-contain" src={image} alt="Receipt" /></button>
      : imageUnavailable ? <div className="mb-5 flex min-h-44 items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">Receipt image is unavailable</div> : null}

    {notice && <Alert className="mb-4"><AlertDescription>{notice}</AlertDescription></Alert>}
    {errors.form && <Alert variant="destructive" className="mb-4" role="alert"><AlertDescription>{errors.form}</AlertDescription></Alert>}

    {editing
      ? <ExpenseForm fields={fields} errors={errors} categories={categories} expanded={expanded} onToggleDetails={() => setExpanded((open) => !open)} onChange={change} onSubmit={save} submitLabel="Save changes" saving={saving} canSubmit={Boolean(fields.categoryId)}
          footerExtra={<Button type="button" variant="outline" className="h-12" disabled={saving} onClick={() => { setEditing(false); setErrors({}); setFields(initial); }}>Cancel</Button>} />
      : <>
        <Summary expense={expense} />
        <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 px-4 pt-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] dark:border-border">
          <div className="mx-auto flex w-full max-w-xl gap-2">
            <Button type="button" variant="outline" className="h-12" onClick={() => setConfirming(true)}>Delete</Button>
            <Button type="button" className="h-12 flex-1" onClick={() => { setNotice(undefined); setEditing(true); }}>Edit</Button>
          </div>
        </div>
      </>}

    {preview && image && <div className="fixed inset-0 z-50 flex bg-black/90 p-4" role="dialog" aria-modal="true"><button className="absolute right-4 top-4 min-h-11 rounded-lg bg-white px-4 text-black" onClick={() => setPreview(false)}>Close</button><img className="m-auto max-h-full max-w-full object-contain" src={image} alt="Receipt full screen" /></div>}

    <Dialog open={confirming} onOpenChange={(open) => { if (!open && !deleting) { setConfirming(false); setDeleteError(undefined); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete expense?</DialogTitle>
          {/* AC-11. The partial unique index frees the receipt the moment the
              expense goes, which is surprising enough that saying nothing would
              read as losing the photograph too. */}
          <DialogDescription>This expense leaves your archive.{expense.receiptId ? ' The receipt goes back to your inbox.' : ''}</DialogDescription>
        </DialogHeader>
        {deleteError && <Alert variant="destructive" role="alert"><AlertDescription>{deleteError}</AlertDescription></Alert>}
        <DialogFooter><DialogClose asChild><Button variant="outline" disabled={deleting}>Cancel</Button></DialogClose><Button variant="destructive" disabled={deleting} onClick={() => void remove()}>{deleting ? 'Deleting…' : 'Delete'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </main>;
}

/** AC-2. Every stored field, and nothing for the ones that are absent. */
function Summary({ expense }: { expense: Expense }) {
  const money = (cents: number | null) => (cents === null ? null : formatMoney(cents, expense.currency));
  // The Category value carries a node so it can show its icon; every other
  // row stays a plain string, and the null-or-empty filter below is unchanged.
  const rows: [string, React.ReactNode | null][] = [
    ['Category', <span className="flex items-center gap-2"><CategoryIcon name={expense.category.name} className="size-4 shrink-0 text-muted-foreground" />{expense.category.name}</span>],
    ['Total', formatMoney(expense.totalCents, expense.currency)],
    ['Date', formatPurchasedOn(expense.purchasedOn)],
    ['Time', expense.purchasedAtTime?.slice(0, 5) ?? null],
    ['Merchant', expense.merchantName],
    ['Tax ID', expense.merchantTaxId],
    ['Receipt number', expense.receiptNumber],
    ['Subtotal', money(expense.subtotalCents)],
    ['Tax', money(expense.taxCents)],
    ['Rounding', money(expense.roundingCents)],
    ['Currency', expense.currency],
    ['Payment method', expense.paymentMethod],
    ['Note', expense.note],
  ];

  return <dl className="grid gap-0 border-t dark:border-border">
    {rows.filter(([, value]) => value !== null && value !== '').map(([label, value]) => <div key={label} className="grid min-h-11 grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-3 border-b py-3 dark:border-border">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words tabular-nums">{value}</dd>
    </div>)}
  </dl>;
}
