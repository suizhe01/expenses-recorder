import { expenseQuery, type ExpenseFilters } from '@/api/expenses';

export type DownloadFailure = { ok: false; status?: number; message: string; fields?: Record<string, string> };
export type DownloadResult = { ok: true } | DownloadFailure;

function filename(header: string | null): string {
  const value = header?.match(/filename="?([^";]+)"?/i)?.[1];
  return value ?? 'download.csv';
}

async function failure(response: Response): Promise<DownloadFailure> {
  const body = await response.json().catch(() => ({})) as { error?: unknown; fields?: unknown };
  return {
    ok: false,
    status: response.status,
    message: typeof body.error === 'string' ? body.error : 'Could not start the download. Please try again.',
    ...(typeof body.fields === 'object' && body.fields !== null ? { fields: body.fields as Record<string, string> } : {}),
  };
}

/** CSV is intentionally buffered; ZIPs use `startZipDownload` instead. */
export async function downloadCsv(
  accessToken: string,
  filters: ExpenseFilters,
  transport: typeof fetch = fetch,
  documentRef: Document = document,
  urlRef: typeof URL = URL,
): Promise<DownloadResult> {
  let response: Response;
  try {
    response = await transport(`/expenses/export.csv${expenseQuery(filters)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { ok: false, message: 'Could not start the download. Please try again.' };
  }
  if (!response.ok) return failure(response);
  const objectUrl = urlRef.createObjectURL(await response.blob());
  const link = documentRef.createElement('a');
  link.href = objectUrl;
  link.download = filename(response.headers.get('content-disposition'));
  link.click();
  urlRef.revokeObjectURL(objectUrl);
  return { ok: true };
}

/** Navigates directly: do not fetch, blob, or arrayBuffer a potentially huge ZIP. */
export function startZipDownload(token: string, filters: ExpenseFilters, navigate: (url: string) => void): void {
  const query = new URLSearchParams(expenseQuery(filters).slice(1));
  query.set('token', token);
  navigate(`/expenses/export.zip?${query.toString()}`);
}
