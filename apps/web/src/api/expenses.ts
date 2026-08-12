import type { ApiRequest, ApiResult } from './client';

export type ExpenseValues = {
  categoryId: string; totalCents: number; purchasedOn: string;
  purchasedAtTime?: string | null; subtotalCents?: number | null; taxCents?: number | null;
  roundingCents?: number | null; currency?: string; merchantName?: string | null;
  merchantTaxId?: string | null; receiptNumber?: string | null; paymentMethod?: string | null; note?: string | null;
  items?: ExpenseItem[];
};

export type ExpenseComponent = {
  description: string | null;
  quantity: string | null;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
};

export type ExpenseItem = ExpenseComponent & { components?: ExpenseComponent[] };

export type ExpenseInput = ExpenseValues & { receiptId?: string | null };

/**
 * EXP-31 AC-6. The API's patch schema is `createSchema.partial()`, where an
 * explicit null clears a field — so an unchanged field must be absent from this
 * object, never present as null.
 */
export type ExpensePatch = Partial<ExpenseInput>;

/**
 * Every field the API stores, matching `expenseResponse`'s allowlist. All of
 * them are named because EXP-31 AC-2 renders all of them; a field typed as
 * optional here would silently never appear.
 */
export type Expense = {
  id: string; category: { id: string; name: string }; receiptId: string | null;
  totalCents: number; purchasedOn: string; purchasedAtTime: string | null;
  subtotalCents: number | null; taxCents: number | null; roundingCents: number | null;
  currency: string; merchantName: string | null; merchantTaxId: string | null;
  receiptNumber: string | null; paymentMethod: string | null; note: string | null;
  items?: ExpenseItem[];
  createdAt: string; updatedAt: string;
};

export type ExpenseFilters = {
  from?: string; to?: string; categoryId?: string[]; hasReceipt?: boolean;
};

export function expenseQuery(filters: ExpenseFilters): string {
  const query = new URLSearchParams();
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  filters.categoryId?.forEach((id) => query.append('categoryId', id));
  if (filters.hasReceipt !== undefined) query.set('hasReceipt', String(filters.hasReceipt));
  const value = query.toString();
  return value === '' ? '' : `?${value}`;
}

export function createExpensesApi(request: ApiRequest) {
  return {
    create: (accessToken: string, body: ExpenseInput): Promise<ApiResult<{ id: string }>> => request('/expenses', { method: 'POST', body, accessToken }),
    list: (accessToken: string, filters: ExpenseFilters = {}): Promise<ApiResult<Expense[]>> => request(`/expenses${expenseQuery(filters)}`, { accessToken }),
    get: (accessToken: string, id: string): Promise<ApiResult<Expense>> => request(`/expenses/${id}`, { accessToken }),
    update: (accessToken: string, id: string, body: ExpensePatch): Promise<ApiResult<Expense>> => request(`/expenses/${id}`, { method: 'PATCH', body, accessToken }),
    remove: (accessToken: string, id: string): Promise<ApiResult<void>> => request(`/expenses/${id}`, { method: 'DELETE', accessToken }),
  };
}
export type ExpensesApi = ReturnType<typeof createExpensesApi>;
