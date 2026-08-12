/**
 * EXP-31 AC-5. The expense form, shared by confirming a receipt (EXP-28) and
 * editing a filed expense.
 *
 * The two screens differ only in where the fields start and what they send:
 * confirm pre-fills from an extraction and POSTs everything, edit pre-fills from
 * the expense and PATCHes only what moved. Both money rules, both date rules and
 * the category picker live here so the two can never drift apart.
 */

import type { FormEvent, ReactNode } from 'react';
import type { Category } from '@/api/categories';
import type { Expense, ExpensePatch, ExpenseValues } from '@/api/expenses';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { centsToDecimal, decimalToCents, todayInMalaysia } from '@/lib/money';

/** Every input, as the string the user actually typed. */
export type ExpenseFields = {
  categoryId: string; total: string; purchasedOn: string; merchantName: string;
  purchasedAtTime: string; merchantTaxId: string; receiptNumber: string;
  subtotal: string; tax: string; rounding: string; currency: string;
  paymentMethod: string; note: string;
};

/** Which API field each input carries. Also the order a patch is built in. */
const API_KEY: Record<keyof ExpenseFields, keyof ExpenseValues> = {
  categoryId: 'categoryId', total: 'totalCents', purchasedOn: 'purchasedOn',
  merchantName: 'merchantName', purchasedAtTime: 'purchasedAtTime',
  merchantTaxId: 'merchantTaxId', receiptNumber: 'receiptNumber',
  subtotal: 'subtotalCents', tax: 'taxCents', rounding: 'roundingCents',
  currency: 'currency', paymentMethod: 'paymentMethod', note: 'note',
};

/** Everything behind "More details", in the order it is shown. */
const COLLAPSED: { label: string; name: keyof ExpenseFields; type?: string; money?: boolean }[] = [
  { label: 'Time', name: 'purchasedAtTime', type: 'time' },
  { label: 'Tax ID', name: 'merchantTaxId' },
  { label: 'Receipt number', name: 'receiptNumber' },
  { label: 'Subtotal', name: 'subtotal', money: true },
  { label: 'Tax', name: 'tax', money: true },
  { label: 'Rounding', name: 'rounding', money: true },
  { label: 'Currency', name: 'currency' },
  { label: 'Payment method', name: 'paymentMethod' },
  { label: 'Note', name: 'note' },
];

/**
 * The API keys behind "More details". A server-side error on one has to open
 * the section, or the message names a field nobody can see. Derived from the
 * list above so the two cannot fall out of step.
 */
export const COLLAPSED_KEYS = new Set<string>(COLLAPSED.map((field) => API_KEY[field.name]));

/** EXP-31 AC-5. The edit screen's starting point, mirroring `validateExpense`. */
export function fieldsFromExpense(expense: Expense): ExpenseFields {
  return {
    categoryId: expense.category.id,
    total: centsToDecimal(expense.totalCents),
    purchasedOn: expense.purchasedOn,
    merchantName: expense.merchantName ?? '',
    // Postgres stores `14:31` as `14:31:00`; an `<input type="time">` holds HH:MM.
    purchasedAtTime: expense.purchasedAtTime?.slice(0, 5) ?? '',
    merchantTaxId: expense.merchantTaxId ?? '',
    receiptNumber: expense.receiptNumber ?? '',
    subtotal: centsToDecimal(expense.subtotalCents),
    tax: centsToDecimal(expense.taxCents),
    rounding: centsToDecimal(expense.roundingCents),
    currency: expense.currency,
    paymentMethod: expense.paymentMethod ?? '',
    note: expense.note ?? '',
  };
}

/**
 * The money and date rules, in one place. A blank optional amount is null rather
 * than zero, and a blank currency is omitted entirely — the API's currency
 * schema is optional but not nullable, so null would be a 400.
 */
export function validateExpense(fields: ExpenseFields): { values?: ExpenseValues; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!fields.categoryId) errors.categoryId = 'Choose a category.';
  if (!fields.purchasedOn) errors.purchasedOn = 'Date is required.';
  else if (fields.purchasedOn > todayInMalaysia()) errors.purchasedOn = 'Date cannot be in the future.';

  const money = (key: 'total' | 'subtotal' | 'tax' | 'rounding', apiKey: string, required = false, positive = false) => {
    const raw = fields[key];
    if (!raw && !required) return null;
    const cents = decimalToCents(raw);
    if (cents === undefined) errors[apiKey] = 'Use a valid amount with no more than 2 decimal places.';
    else if (positive && cents <= 0) errors[apiKey] = 'Total must be greater than zero.';
    else if ((key === 'subtotal' || key === 'tax') && cents < 0) errors[apiKey] = 'Amount cannot be negative.';
    return cents;
  };

  const total = money('total', 'totalCents', true, true);
  const subtotal = money('subtotal', 'subtotalCents');
  const tax = money('tax', 'taxCents');
  const rounding = money('rounding', 'roundingCents');

  if (Object.keys(errors).length) return { errors };

  return {
    errors,
    values: {
      categoryId: fields.categoryId,
      totalCents: total!,
      purchasedOn: fields.purchasedOn,
      purchasedAtTime: fields.purchasedAtTime || null,
      subtotalCents: subtotal,
      taxCents: tax,
      roundingCents: rounding,
      ...(fields.currency ? { currency: fields.currency } : {}),
      merchantName: fields.merchantName || null,
      merchantTaxId: fields.merchantTaxId || null,
      receiptNumber: fields.receiptNumber || null,
      paymentMethod: fields.paymentMethod || null,
      note: fields.note || null,
    },
  };
}

/**
 * EXP-31 AC-6. Only what the user actually changed.
 *
 * `patchSchema` is `createSchema.partial()` and an explicit null clears a field,
 * so sending the whole validated object would wipe every field the user left
 * alone: correcting a total would silently erase the merchant. Comparing the
 * typed strings rather than the parsed values is what keeps `14:31` against a
 * stored `14:31:00` from reading as an edit.
 */
export function changedFields(initial: ExpenseFields, current: ExpenseFields, values: ExpenseValues): ExpensePatch {
  const patch: Record<string, unknown> = {};

  for (const key of Object.keys(API_KEY) as (keyof ExpenseFields)[]) {
    if (initial[key] === current[key]) continue;

    // Currency has no null form server-side, so clearing it is not expressible.
    // Omitting leaves the stored code as it was rather than sending a 400.
    if (key === 'currency' && values.currency === undefined) continue;

    patch[API_KEY[key]] = values[API_KEY[key]];
  }

  return patch as ExpensePatch;
}

export function ExpenseForm({ fields, errors, categories, expanded, onToggleDetails, onChange, onSubmit, submitLabel, saving, canSubmit, footerExtra }: {
  fields: ExpenseFields;
  errors: Record<string, string>;
  categories: Category[];
  expanded: boolean;
  onToggleDetails: () => void;
  onChange: (name: keyof ExpenseFields, value: string) => void;
  onSubmit: (event: FormEvent) => void;
  submitLabel: string;
  saving: boolean;
  canSubmit: boolean;
  footerExtra?: ReactNode;
}) {
  return <form onSubmit={onSubmit} className="grid gap-4">
    <Field label="Category" error={errors.categoryId}><select aria-label="Category" value={fields.categoryId} onChange={(event) => onChange('categoryId', event.target.value)} className="h-11 w-full rounded-lg border bg-background px-2.5 text-base"><option value="">Choose a category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
    <Field label="Total" error={errors.totalCents}><Input aria-label="Total" inputMode="decimal" value={fields.total} onChange={(event) => onChange('total', event.target.value)} /></Field>
    <Field label="Date" error={errors.purchasedOn}><Input aria-label="Date" type="date" max={todayInMalaysia()} value={fields.purchasedOn} onChange={(event) => onChange('purchasedOn', event.target.value)} /></Field>
    <Field label="Merchant" error={errors.merchantName}><Input aria-label="Merchant" value={fields.merchantName} onChange={(event) => onChange('merchantName', event.target.value)} /></Field>
    <Button type="button" variant="outline" className="h-11" onClick={onToggleDetails} aria-expanded={expanded}>More details</Button>
    {expanded && <div className="grid gap-4 rounded-xl border p-4 dark:border-border">{COLLAPSED.map(({ label, name, type, money }) => <Field key={name} label={label} error={errors[API_KEY[name]]}><Input aria-label={label} type={type ?? 'text'} inputMode={money ? 'decimal' : undefined} value={fields[name]} onChange={(event) => onChange(name, event.target.value)} /></Field>)}</div>}
    <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 px-4 pt-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] dark:border-border"><div className="mx-auto flex w-full max-w-xl gap-2">{footerExtra}<Button className="h-12 flex-1" type="submit" disabled={!canSubmit || saving}>{saving ? 'Saving…' : submitLabel}</Button></div></div>
  </form>;
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return <div className="grid gap-2"><Label>{label}</Label>{children}{error && <p className="text-sm text-destructive" role="alert">{error}</p>}</div>;
}
