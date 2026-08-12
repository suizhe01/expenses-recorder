import type { ApiRequest, ApiResult } from './client';

export type Extraction = {
  status: string;
  isReceipt?: boolean | null;
  merchantName: string | null;
  merchantTaxId?: string | null;
  receiptNumber?: string | null;
  purchasedOn: string | null;
  purchasedAtTime?: string | null;
  subtotalCents?: number | null;
  taxCents?: number | null;
  roundingCents?: number | null;
  totalCents: number | null;
  currency: string | null;
  paymentMethod?: string | null;
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
    image(accessToken: string, id: string): Promise<ApiResult<Blob>> {
      return request<Blob>(`/receipts/${id}/file`, { accessToken, responseType: 'blob' });
    },
  };
}

export type ReceiptsApi = ReturnType<typeof createReceiptsApi>;
