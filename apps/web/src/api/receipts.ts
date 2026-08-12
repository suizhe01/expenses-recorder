import type { ApiRequest, ApiResult } from './client';

export type Extraction = {
  status: string;
  merchantName: string | null;
  purchasedOn: string | null;
  totalCents: number | null;
  currency: string | null;
};

export type Receipt = {
  id: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  createdAt: string;
  extraction: Extraction | null;
  expenseId: string | null;
};

export function createReceiptsApi(request: ApiRequest) {
  return {
    list(accessToken: string): Promise<ApiResult<Receipt[]>> {
      return request<Receipt[]>('/receipts', { accessToken });
    },
    upload(accessToken: string, file: File): Promise<ApiResult<Receipt>> {
      const body = new FormData();
      body.append('file', file);
      return request<Receipt>('/receipts', { method: 'POST', body, accessToken });
    },
    remove(accessToken: string, id: string): Promise<ApiResult<void>> {
      return request<void>(`/receipts/${id}`, { method: 'DELETE', accessToken });
    },
  };
}

export type ReceiptsApi = ReturnType<typeof createReceiptsApi>;
