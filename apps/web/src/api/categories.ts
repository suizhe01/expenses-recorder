import type { ApiRequest, ApiResult } from './client';

export type Category = { id: string; name: string; createdAt: string; updatedAt: string };

export function createCategoriesApi(request: ApiRequest) {
  return { list: (accessToken: string): Promise<ApiResult<Category[]>> => request('/categories', { accessToken }) };
}

export type CategoriesApi = ReturnType<typeof createCategoriesApi>;
