import type { ApiRequest, ApiResult } from './client';

export type Category = { id: string; name: string; createdAt: string; updatedAt: string };

export function createCategoriesApi(request: ApiRequest) {
  return {
    list: (accessToken: string): Promise<ApiResult<Category[]>> => request('/categories', { accessToken }),
    create: (accessToken: string, name: string): Promise<ApiResult<Category>> => request('/categories', { method: 'POST', body: { name }, accessToken }),
    rename: (accessToken: string, id: string, name: string): Promise<ApiResult<Category>> => request(`/categories/${id}`, { method: 'PATCH', body: { name }, accessToken }),
    remove: (accessToken: string, id: string): Promise<ApiResult<void>> => request(`/categories/${id}`, { method: 'DELETE', accessToken }),
  };
}

export type CategoriesApi = ReturnType<typeof createCategoriesApi>;
