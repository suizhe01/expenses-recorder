import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { createAuthApi } from '@/api/auth';
import { createClient, type ApiResult } from '@/api/client';
import type { CategoriesApi, Category } from '@/api/categories';
import { CategoriesScreen } from '@/routes/categories';
import { SessionProvider } from '@/session/context';
import { createSessionManager } from '@/session/session';
import { fakeStorage, session } from '@/test/support';

afterEach(cleanup);

const categories: Category[] = [
  { id: 'b', name: 'Food', createdAt: '', updatedAt: '' },
  { id: 'a', name: 'Education', createdAt: '', updatedAt: '' },
];

type Options = { rows?: Category[]; create?: ApiResult<Category>; rename?: ApiResult<Category>; remove?: ApiResult<void>; holdCreate?: boolean };

async function mount(options: Options = {}) {
  const rows = options.rows ?? categories;
  const list = vi.fn(async (): Promise<ApiResult<Category[]>> => ({ kind: 'ok', status: 200, body: rows }));
  const create = vi.fn(async (): Promise<ApiResult<Category>> => options.holdCreate ? new Promise<ApiResult<Category>>(() => undefined) : options.create ?? { kind: 'ok', status: 201, body: { id: 'new', name: 'Kopi & Roti', createdAt: '', updatedAt: '' } });
  const rename = vi.fn(async (): Promise<ApiResult<Category>> => options.rename ?? { kind: 'ok', status: 200, body: { ...categories[0]!, name: 'Meals' } });
  const remove = vi.fn(async (): Promise<ApiResult<void>> => options.remove ?? { kind: 'ok', status: 204, body: undefined as void });
  const manager = createSessionManager({ auth: createAuthApi(createClient('', async () => new Response(JSON.stringify(session()), { status: 200 }))), storage: fakeStorage() });
  await manager.signIn('someone@example.com', 'password');
  render(<SessionProvider manager={manager}><MemoryRouter><CategoriesScreen categoriesApi={{ list, create, rename, remove } as CategoriesApi} /></MemoryRouter></SessionProvider>);
  return { list, create, rename, remove };
}

async function openActions(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
}

describe('category management', () => {
  it('lists live categories alphabetically and offers add for an empty legacy account', async () => {
    await mount();
    const names = (await screen.findAllByText(/Education|Food/)).map((node) => node.textContent);
    expect(names).toEqual(['Education', 'Food']);
    await mount({ rows: [] });
    expect(await screen.findByText('No categories yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add category' }).length).toBeGreaterThan(0);
  });

  it('validates name length on blur before sending a create request', async () => {
    const { create } = await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Add category' }));
    await userEvent.type(screen.getByLabelText('Category name'), 'x'.repeat(51));
    fireEvent.blur(screen.getByLabelText('Category name'));
    expect(await screen.findByText('Name must be at most 50 characters.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('puts a duplicate create response on the field and focuses it', async () => {
    const { create } = await mount({ create: { kind: 'error', status: 409, message: 'A category with that name already exists' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Add category' }));
    await userEvent.type(screen.getByLabelText('Category name'), 'Kopi & Roti');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('A category with that name already exists')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Category name')).toHaveFocus());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('uses the same validation for rename and only shows the history note there', async () => {
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Add category' }));
    expect(screen.queryByText('Renaming updates this category on every expense that uses it.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await openActions('Food');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('Renaming updates this category on every expense that uses it.')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Category name'));
    await userEvent.type(screen.getByLabelText('Category name'), 'x'.repeat(51));
    fireEvent.blur(screen.getByLabelText('Category name'));
    expect(await screen.findByText('Name must be at most 50 characters.')).toBeInTheDocument();
  });

  it('puts a duplicate rename response on the same focused field', async () => {
    const duplicate = 'A category with that name already exists';
    const { rename } = await mount({ rename: { kind: 'error', status: 409, message: duplicate } });
    await openActions('Food');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await userEvent.clear(screen.getByLabelText('Category name'));
    await userEvent.type(screen.getByLabelText('Category name'), 'Meals');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(duplicate)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Category name')).toHaveFocus());
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('confirms deletion with the history consequence and refreshes with a success notice', async () => {
    const { remove, list } = await mount();
    await openActions('Education');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Delete category?' })).toBeInTheDocument();
    expect(within(dialog).getByText("Expenses already filed keep this category's name, but you won't be able to filter by it.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Category deleted.')).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  it('disables deletion with no request at exactly one category and permits it at two', async () => {
    const one = [{ id: 'only', name: 'Only', createdAt: '', updatedAt: '' }];
    const { remove } = await mount({ rows: one });
    await openActions('Only');
    const disabled = screen.getByRole('button', { name: 'Delete' });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(remove).not.toHaveBeenCalled();
    cleanup();
    await mount();
    await openActions('Food');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('sends exactly one create request for synchronous double taps', async () => {
    const { create } = await mount({ holdCreate: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Add category' }));
    await userEvent.type(screen.getByLabelText('Category name'), 'Kopi & Roti');
    const add = screen.getByRole('button', { name: 'Add' });
    await act(async () => { add.click(); add.click(); });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });
});
