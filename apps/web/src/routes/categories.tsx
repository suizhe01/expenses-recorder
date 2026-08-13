import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { createClient } from '@/api/client';
import { createCategoriesApi, type CategoriesApi, type Category } from '@/api/categories';
import { describeFailure } from '@/api/messages';
import { CLIENT_ROUTES } from '@/client-routes';
import { CategoryIcon } from '@/components/category-icon';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useSession } from '@/session/context';

type Mode = { kind: 'add' } | { kind: 'rename'; category: Category };
const duplicate = 'A category with that name already exists';

function validateName(value: string): string | undefined {
  const length = value.trim().length;
  if (length === 0) return 'Name is required.';
  if (length > 50) return 'Name must be at most 50 characters.';
}

export function CategoriesScreen({ categoriesApi }: { categoriesApi?: CategoriesApi } = {}) {
  const { session } = useSession();
  const defaultApi = useMemo(() => createCategoriesApi(createClient('', (url, init) => fetch(url, init))), []);
  const api = categoriesApi ?? defaultApi;
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<Mode>();
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState<Category>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deletePending, setDeletePending] = useState(false);
  const deletingRef = useRef(false);
  const [menu, setMenu] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function refresh() {
    const result = await session.authorized((token) => api.list(token));
    if (result.kind === 'ok') setCategories([...result.body].sort((a, b) => a.name.localeCompare(b.name)));
    else if (!(result.kind === 'error' && result.status === 401)) setError(describeFailure(result));
    setLoading(false);
  }
  // This is the one-time route loader; refresh is also deliberately reused
  // after mutations to make the live list authoritative.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [api, session]);
  useEffect(() => { if (mode) window.setTimeout(() => nameInput.current?.focus()); }, [mode]);

  function openAdd() { setName(''); setFieldError(undefined); setMode({ kind: 'add' }); }
  function openRename(category: Category) { setName(category.name); setFieldError(undefined); setMode({ kind: 'rename', category }); setMenu(undefined); }
  function validateOnBlur() { const message = validateName(name); setFieldError(message); }
  function failField(message: string) { setFieldError(message); window.setTimeout(() => nameInput.current?.focus()); }
  async function save() {
    if (!mode || savingRef.current) return;
    const invalid = validateName(name);
    if (invalid) { failField(invalid); return; }
    savingRef.current = true; setSaving(true); setFieldError(undefined);
    const result = await session.authorized((token) => mode.kind === 'add' ? api.create(token, name.trim()) : api.rename(token, mode.category.id, name.trim()));
    savingRef.current = false; setSaving(false);
    if (result.kind === 'ok') { setMode(undefined); setNotice(mode.kind === 'add' ? 'Category added.' : 'Category renamed.'); await refresh(); return; }
    if (result.kind === 'error' && result.status === 409) { failField(duplicate); return; }
    if (result.kind === 'error' && result.status === 400) { failField(result.fields?.name ?? result.message); return; }
    if (!(result.kind === 'error' && result.status === 401)) setError(describeFailure(result));
  }
  async function remove() {
    if (!deleting || deletingRef.current) return;
    deletingRef.current = true; setDeletePending(true); setDeleteError(undefined);
    const result = await session.authorized((token) => api.remove(token, deleting.id));
    if (result.kind === 'ok') { setDeleting(undefined); setNotice('Category deleted.'); await refresh(); return; }
    deletingRef.current = false; setDeletePending(false);
    if (!(result.kind === 'error' && result.status === 401)) setDeleteError(describeFailure(result));
  }
  const lastCategory = categories.length === 1;
  return <main className="mx-auto min-h-dvh w-full max-w-xl overflow-x-hidden px-4 pb-8"><header className="flex items-center gap-2 border-b py-3 dark:border-border"><Button asChild variant="ghost" size="icon" className="size-11" aria-label="Back"><Link to={CLIENT_ROUTES.settings}><ChevronLeft /></Link></Button><div><h1 className="font-heading text-lg font-semibold">Categories</h1><p className="text-sm text-muted-foreground">Manage your expense categories</p></div></header>
    <div className="flex items-center justify-between gap-3 py-4"><p className="text-sm text-muted-foreground">{categories.length} {categories.length === 1 ? 'category' : 'categories'}</p><Button className="h-11" onClick={openAdd}><Plus />Add category</Button></div>
    {notice && <p className="mb-3 text-sm" aria-live="polite">{notice}</p>}{error && <Alert variant="destructive" role="alert" className="mb-3"><AlertDescription>{error}</AlertDescription></Alert>}
    <p className="sr-only" aria-live="polite">{loading ? 'Loading categories' : `${categories.length} categories shown`}</p>
    {loading ? <p className="py-8 text-muted-foreground">Loading categories…</p> : categories.length === 0 ? <section className="rounded-xl border border-dashed p-8 text-center dark:border-border"><p className="font-medium">No categories yet</p><p className="mt-1 text-sm text-muted-foreground">Add one to file expenses.</p><Button className="mt-4 h-11" onClick={openAdd}>Add category</Button></section> : <div className="grid gap-2">{categories.map((category) => <article key={category.id} className="flex min-h-14 items-center justify-between gap-2 rounded-xl border px-3 dark:border-border"><p className="flex min-w-0 items-center gap-3 font-medium"><CategoryIcon name={category.name} className="size-5 shrink-0 text-muted-foreground" /><span className="truncate">{category.name}</span></p><div className="relative"><Button variant="ghost" size="icon" className="size-11" aria-label={`Actions for ${category.name}`} aria-expanded={menu === category.id} onClick={() => setMenu(menu === category.id ? undefined : category.id)}><MoreHorizontal /></Button>{menu === category.id && <div className="absolute right-0 z-10 mt-1 grid min-w-32 gap-1 rounded-xl border bg-background p-1 shadow-lg dark:border-border"><Button variant="ghost" className="h-11 justify-start" onClick={() => openRename(category)}><Pencil />Rename</Button><Button variant="ghost" className="h-11 justify-start" disabled={lastCategory} title={lastCategory ? 'At least one category is needed to file an expense.' : undefined} onClick={() => { setDeleting(category); setMenu(undefined); }}><Trash2 />Delete</Button></div>}</div></article>)}</div>}
    {lastCategory && <p className="mt-3 text-sm text-muted-foreground">At least one category is needed to file an expense.</p>}
    <Dialog open={mode !== undefined} onOpenChange={(open) => { if (!open && !saving) setMode(undefined); }}><DialogContent><DialogHeader><DialogTitle>{mode?.kind === 'rename' ? 'Rename category' : 'Add category'}</DialogTitle><DialogDescription>{mode?.kind === 'rename' ? 'Renaming updates this category on every expense that uses it.' : 'Use any name up to 50 characters.'}</DialogDescription></DialogHeader><label className="grid gap-2 text-sm font-medium">Name<Input ref={nameInput} aria-label="Category name" value={name} onChange={(event) => { setName(event.target.value); setFieldError(undefined); }} onBlur={validateOnBlur} aria-invalid={fieldError ? true : undefined} /></label>{fieldError && <p className="text-sm text-destructive" role="alert">{fieldError}</p>}{error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}<DialogFooter><DialogClose asChild><Button variant="outline" disabled={saving}>Cancel</Button></DialogClose><Button disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : mode?.kind === 'rename' ? 'Save' : 'Add'}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={deleting !== undefined} onOpenChange={(open) => { if (!open && !deletePending) { setDeleting(undefined); setDeleteError(undefined); } }}><DialogContent><DialogHeader><DialogTitle>Delete category?</DialogTitle><DialogDescription>Expenses already filed keep this category&apos;s name, but you won&apos;t be able to filter by it.</DialogDescription></DialogHeader>{deleteError && <Alert variant="destructive" role="alert"><AlertDescription>{deleteError}</AlertDescription></Alert>}<DialogFooter><DialogClose asChild><Button variant="outline" disabled={deletePending}>Cancel</Button></DialogClose><Button variant="destructive" disabled={deletePending} onClick={() => void remove()}>{deletePending ? 'Deleting…' : 'Delete'}</Button></DialogFooter></DialogContent></Dialog>
  </main>;
}
