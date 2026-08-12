import type { ApiRequest, ApiResult } from './client';

export type ExpenseInput = {
  categoryId: string; receiptId: string; totalCents: number; purchasedOn: string;
  purchasedAtTime?: string | null; subtotalCents?: number | null; taxCents?: number | null;
  roundingCents?: number | null; currency?: string; merchantName?: string | null;
  merchantTaxId?: string | null; receiptNumber?: string | null; paymentMethod?: string | null; note?: string | null;
};

export type Expense = {
  id: string; category: { id: string; name: string }; receiptId: string | null;
  totalCents: number; purchasedOn: string; currency: string; merchantName: string | null;
  receiptNumber: string | null; note: string | null;
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
  };
}
export type ExpensesApi = ReturnType<typeof createExpensesApi>;
