import type { ApiRequest, ApiResult } from './client';

export type DownloadToken = { token: string; expiresAt: string };

export function createExportsApi(request: ApiRequest) {
  return {
    createToken: (accessToken: string): Promise<ApiResult<DownloadToken>> =>
      request('/exports/token', { method: 'POST', accessToken }),
  };
}

export type ExportsApi = ReturnType<typeof createExportsApi>;
