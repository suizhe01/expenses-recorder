import type { ApiRequest, ApiResult } from './client';

export type ExpenseInput = {
  categoryId: string; receiptId: string; totalCents: number; purchasedOn: string;
  purchasedAtTime?: string | null; subtotalCents?: number | null; taxCents?: number | null;
  roundingCents?: number | null; currency?: string; merchantName?: string | null;
  merchantTaxId?: string | null; receiptNumber?: string | null; paymentMethod?: string | null; note?: string | null;
};
export function createExpensesApi(request: ApiRequest) {
  return { create: (accessToken: string, body: ExpenseInput): Promise<ApiResult<{ id: string }>> => request('/expenses', { method: 'POST', body, accessToken }) };
}
export type ExpensesApi = ReturnType<typeof createExpensesApi>;
