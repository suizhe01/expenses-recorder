import { downloadCsv, startZipDownload } from './download';

describe('export downloads', () => {
  it('AC-3: honors the server filename and revokes the CSV object URL', async () => {
    const click = vi.fn();
    const createElement = vi.fn(() => ({ href: '', download: '', click }));
    const createObjectURL = vi.fn(() => 'blob:csv');
    const revokeObjectURL = vi.fn();
    const transport = vi.fn(async () => new Response('CSV', {
      status: 200,
      headers: { 'content-disposition': 'attachment; filename="unexpected.csv"' },
    }));

    const result = await downloadCsv('access', { from: '2026-08-01' }, transport, { createElement } as unknown as Document, { createObjectURL, revokeObjectURL } as unknown as typeof URL);

    expect(result).toEqual({ ok: true });
    expect(transport).toHaveBeenCalledWith('/expenses/export.csv?from=2026-08-01', expect.objectContaining({ headers: { authorization: 'Bearer access' } }));
    expect(createElement.mock.results[0]!.value.download).toBe('unexpected.csv');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:csv');
  });

  it('AC-5: navigates directly for ZIPs without reading a response body', () => {
    const navigate = vi.fn();
    startZipDownload('secret-token', { categoryId: ['cat-1'], hasReceipt: true }, navigate);
    expect(navigate).toHaveBeenCalledWith('/expenses/export.zip?categoryId=cat-1&hasReceipt=true&token=secret-token');
  });
});
