import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Link } from "react-router";
import { createClient } from "@/api/client";
import {
  createExpensesApi,
  type Expense,
  type ExpensesApi,
} from "@/api/expenses";
import {
  createReceiptsApi,
  type Receipt,
  type ReceiptsApi,
} from "@/api/receipts";
import { describeFailure } from "@/api/messages";
import { CLIENT_ROUTES, confirmReceiptPath } from "@/client-routes";
import { TabBar } from "@/components/tab-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/session/context";
import { currentMonth, donutSlices, overviewFor } from "@/expenses/aggregate";
import { CategoryDonut } from "@/charts/donut";
import { formatMoney, monthLabel } from "./expenses";

function monthChoices(expenses: Expense[], selected: string): string[] {
  return [
    ...new Set([
      ...expenses.map((expense) => expense.purchasedOn.slice(0, 7)),
      selected,
    ]),
  ]
    .sort()
    .reverse();
}

export function OverviewScreen({
  expensesApi,
  receiptsApi,
}: { expensesApi?: Pick<ExpensesApi, 'list'>; receiptsApi?: ReceiptsApi } = {}) {
  const { session } = useSession();
  const defaultExpenses = useMemo(
    () => createExpensesApi(createClient("", (url, init) => fetch(url, init))),
    [],
  );
  const defaultReceipts = useMemo(
    () => createReceiptsApi(createClient("", (url, init) => fetch(url, init))),
    [],
  );
  const expenseApi = expensesApi ?? defaultExpenses;
  const receiptApi = receiptsApi ?? defaultReceipts;
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [month, setMonth] = useState(currentMonth);
  const [currency, setCurrency] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<Receipt>();
  const [deleteError, setDeleteError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void Promise.all([
        session.authorized((token) => expenseApi.list(token)),
        session.authorized((token) => receiptApi.list(token)),
      ]).then(([expenseResult, receiptResult]) => {
        if (cancelled) return;
        if (expenseResult.kind === "ok") setExpenses(expenseResult.body);
        else if (!(
          expenseResult.kind === "error" && expenseResult.status === 401
        ))
          setError(describeFailure(expenseResult));
        if (receiptResult.kind === "ok")
          setReceipts(
            receiptResult.body.filter((receipt) => receipt.expenseId === null),
          );
        else if (!(
          receiptResult.kind === "error" && receiptResult.status === 401
        ))
          setError(describeFailure(receiptResult));
        setLoading(false);
      });
    load();
    window.addEventListener("receipt-uploaded", load);
    return () => {
      cancelled = true;
      window.removeEventListener("receipt-uploaded", load);
    };
  }, [expenseApi, receiptApi, session]);
  const overview = overviewFor(expenses, month, currency);
  const visible = overview;
  const slices = visible ? donutSlices(visible.categories) : [];
  async function remove() {
    if (!deleting) return;
    setDeleteError(undefined);
    const result = await session.authorized((token) => receiptApi.remove(token, deleting.id));
    if (result.kind === "ok") {
      setReceipts((current) => current.filter((receipt) => receipt.id !== deleting.id));
      setDeleting(undefined);
    } else if (result.kind === "error" && result.status === 409) {
      setDeleteError("This receipt is attached to an expense. Delete the expense first.");
    } else if (!(result.kind === "error" && result.status === 401)) {
      setDeleteError(describeFailure(result));
    }
  }
  return (
    <main className="mx-auto min-h-dvh w-full max-w-xl overflow-x-hidden px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
      <header className="flex items-center justify-between gap-3 border-b py-4 dark:border-border">
        <div><h1 className="font-heading text-lg font-semibold">Overview</h1><p className="text-sm text-muted-foreground">Your monthly spending summary</p></div>
        <Link to={CLIENT_ROUTES.settings} className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">Settings</Link>
      </header>
      {error && (
        <Alert variant="destructive" role="alert" className="mt-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <p className="py-8 text-muted-foreground">Loading overview…</p>
      ) : !overview ? (
        <section className="py-10 text-center">
          <p className="font-medium">Nothing filed yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Use the + button to capture your first receipt.
          </p>
        </section>
      ) : (
        <>
          <div className="flex gap-2 py-4">
            <label className="min-w-0 flex-1 text-sm font-medium">
              Month
              <select
                aria-label="Overview month"
                className="mt-1 h-11 w-full rounded-lg border bg-transparent px-2 text-base"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
              >
                {monthChoices(expenses, month).map((value) => (
                  <option key={value} value={value}>
                    {monthLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            {visible!.currencies.length > 1 && (
              <label className="min-w-0 flex-1 text-sm font-medium">
                Currency
                <select
                  aria-label="Overview currency"
                  className="mt-1 h-11 w-full rounded-lg border bg-transparent px-2 text-base"
                  value={visible!.currency}
                  onChange={(event) => setCurrency(event.target.value)}
                >
                  {visible!.currencies.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <section
            aria-label="Monthly total"
            className="rounded-xl border p-5 dark:border-border"
          >
            <p className="text-sm text-muted-foreground">{monthLabel(month)}</p>
            <p className="mt-1 text-4xl font-semibold tabular-nums">
              {formatMoney(visible!.totalCents, visible!.currency)}
            </p>
            {visible!.percentChange !== undefined && (
              <p className="mt-2 text-sm text-muted-foreground">
                {visible!.percentChange <= 0 ? "↓" : "↑"}{" "}
                {Math.abs(visible!.percentChange)}% vs last month
              </p>
            )}
          </section>
          <div className="py-4">
            <CategoryDonut
              slices={slices}
              totalLabel={
                slices.length
                  ? formatMoney(visible!.totalCents, visible!.currency)
                  : ""
              }
              formatAmount={(cents) => formatMoney(cents, visible!.currency)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 py-4">
            <section className="rounded-xl border p-4 dark:border-border">
              <p className="text-xs text-muted-foreground">Avg monthly spend</p>
              <p className="mt-1 font-medium tabular-nums">
                {formatMoney(visible!.averageMonthlyCents, visible!.currency)}
              </p>
            </section>
            <section className="rounded-xl border p-4 dark:border-border">
              <p className="text-xs text-muted-foreground">Busiest day</p>
              <p className="mt-1 font-medium">{visible!.busiestDay ?? "—"}</p>
            </section>
          </div>
          <section>
            <h2 className="mb-2 font-semibold">Category breakdown</h2>
            {slices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No expenses this month.
              </p>
            ) : (
              <div className="grid gap-2">
                {slices.map((slice) => (
                  <div
                    key={slice.id}
                    className="flex min-h-11 items-center justify-between rounded-lg border px-3 dark:border-border"
                  >
                    <p className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-3 rounded-full"
                        style={{ backgroundColor: slice.color }}
                      />
                      {slice.name}{" "}
                      <span className="text-sm text-muted-foreground">
                        · {slice.count}
                      </span>
                    </p>
                    <p className="font-medium tabular-nums">
                      {formatMoney(slice.totalCents, visible!.currency)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {receipts.length > 0 && (
        <section className="mt-5">
          <h2 className="mb-2 font-semibold">{receipts.length} to file</h2>
          <div className="grid gap-2">
            {receipts.map((receipt) => <div key={receipt.id} className="flex min-w-0 items-center gap-2 rounded-lg border p-1 dark:border-border">
              <Link to={confirmReceiptPath(receipt.id)} className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-2">
                <span className="truncate font-medium">{receipt.extraction?.merchantName ?? receipt.originalFilename ?? "Receipt"}</span>
                <span className="shrink-0 text-sm text-muted-foreground">File receipt</span>
              </Link>
              <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label={`Delete ${receipt.originalFilename ?? "receipt"}`} onClick={() => { setDeleting(receipt); setDeleteError(undefined); }}><Trash2 aria-hidden="true" /></Button>
            </div>)}
          </div>
        </section>
      )}
      <Dialog open={deleting !== undefined} onOpenChange={(open) => { if (!open) { setDeleting(undefined); setDeleteError(undefined); } }}>
        <DialogContent><DialogHeader><DialogTitle>Delete receipt?</DialogTitle><DialogDescription>Delete this receipt? It leaves your inbox.</DialogDescription></DialogHeader>{deleteError && <Alert variant="destructive" role="alert"><AlertDescription>{deleteError}</AlertDescription></Alert>}<DialogFooter><DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose><Button variant="destructive" onClick={() => void remove()}>Delete</Button></DialogFooter></DialogContent>
      </Dialog>
      <TabBar active="overview" />
    </main>
  );
}
