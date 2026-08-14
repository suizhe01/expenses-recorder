import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ChevronLeft, Trash2 } from 'lucide-react';
import { createClient } from '@/api/client';
import { createMerchantCorrectionsApi, type MerchantCorrection } from '@/api/merchant-corrections';
import { createCategoriesApi, type Category } from '@/api/categories';
import { useSession } from '@/session/context';
import { CLIENT_ROUTES } from '@/client-routes';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function MerchantCorrectionsScreen() {
  const { session } = useSession();
  const api = useMemo(() => createMerchantCorrectionsApi(createClient('', fetch)), []);
  const categoriesApi = useMemo(() => createCategoriesApi(createClient('', fetch)), []);
  const [rules, setRules] = useState<MerchantCorrection[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  // undefined closes the editor; null deliberately means a new correction.
  const [editing, setEditing] = useState<MerchantCorrection | null | undefined>();
  const [detected, setDetected] = useState('');
  const [merchant, setMerchant] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([
      session.authorized((token) => api.list(token)),
      session.authorized((token) => categoriesApi.list(token)),
    ]).then(([rulesResult, categoriesResult]) => {
      if (rulesResult.kind === 'ok') setRules(rulesResult.body);
      if (categoriesResult.kind === 'ok') setCategories(categoriesResult.body);
      if (rulesResult.kind !== 'ok' || categoriesResult.kind !== 'ok') {
        setError('Could not load merchant corrections. Please refresh and try again.');
      }
      setLoading(false);
    });
  }, [api, categoriesApi, session]);

  function openEditor(rule: MerchantCorrection | null) {
    setEditing(rule);
    setDetected(rule?.detectedName ?? '');
    setMerchant(rule?.merchantName ?? '');
    setCategory(rule?.categoryId ?? categories[0]?.id ?? '');
    setError('');
  }

  async function save() {
    if (!detected.trim() || !merchant.trim() || !category) {
      setError('Detected name, corrected merchant, and category are required.');
      return;
    }
    const result = await session.authorized((token) => editing
      ? api.update(token, editing.id, { detectedName: detected, merchantName: merchant, categoryId: category })
      : api.create(token, { detectedName: detected, merchantName: merchant, categoryId: category }));
    if (result.kind !== 'ok') {
      setError('Could not save correction. Check the fields and try again.');
      return;
    }
    setRules((current) => editing
      ? current.map((rule) => rule.id === editing.id ? result.body : rule)
      : [...current, result.body]);
    setEditing(undefined);
  }

  async function remove(rule: MerchantCorrection) {
    setError('');
    const result = await session.authorized((token) => api.remove(token, rule.id));
    if (result.kind !== 'ok') {
      setError(`Could not delete “${rule.detectedName}”. It is still saved.`);
      return;
    }
    setRules((current) => current.filter((currentRule) => currentRule.id !== rule.id));
  }

  return <main className="mx-auto min-h-dvh w-full max-w-xl px-4 pb-8">
    <header className="flex items-center gap-2 border-b py-3">
      <Button asChild variant="ghost" size="icon" aria-label="Back"><Link to={CLIENT_ROUTES.settings}><ChevronLeft /></Link></Button>
      <div><h1 className="font-heading text-lg font-semibold">Merchant corrections</h1><p className="text-sm text-muted-foreground">Optional suggestions for receipt readings</p></div>
    </header>
    {error && <Alert variant="destructive" className="mt-4" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    {loading ? <p className="mt-4" aria-busy="true">Loading corrections…</p> : <>
      <Button className="mt-4" onClick={() => openEditor(null)}>Add correction</Button>
      {editing !== undefined && <section className="mt-4 grid gap-3 rounded-xl border p-4">
        <label>Detected name<Input value={detected} onChange={(event) => setDetected(event.target.value)} /></label>
        <label>Correct merchant<Input value={merchant} onChange={(event) => setMerchant(event.target.value)} /></label>
        <label>Category<select className="h-11 w-full rounded-lg border" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Choose a category</option>{categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <div className="flex gap-2"><Button onClick={() => void save()}>Save correction</Button><Button variant="outline" onClick={() => setEditing(undefined)}>Cancel</Button></div>
      </section>}
      <div className="mt-4 grid gap-2">{rules.map((rule) => <div key={rule.id} className="flex items-center justify-between rounded-xl border p-3">
        <button className="text-left" onClick={() => openEditor(rule)}><b>{rule.detectedName}</b><br /><span>{rule.merchantName} · {rule.categoryActive ? rule.categoryName : 'Category unavailable'}</span></button>
        <Button variant="ghost" size="icon" aria-label={`Delete ${rule.detectedName}`} onClick={() => void remove(rule)}><Trash2 /></Button>
      </div>)}</div>
    </>}
  </main>;
}
