import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { createClient } from '@/api/client';
import { createCategoriesApi, type Category } from '@/api/categories';
import { createExpensesApi, type ExpenseItem } from '@/api/expenses';
import { createReceiptsApi, type Receipt } from '@/api/receipts';
import { describeFailure } from '@/api/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { COLLAPSED_KEYS, ExpenseForm, validateExpense, type ExpenseFields } from '@/components/expense-form';
import { useSession } from '@/session/context';
import { centsToDecimal, decimalToCents, todayInMalaysia } from '@/lib/money';

const transport = (url: string, init: RequestInit) => fetch(url, init);

type ComponentFields = { description: string; quantity: string; unitPrice: string; lineTotal: string };
type ItemFields = ComponentFields & { components: ComponentFields[] };
const emptyComponent = (): ComponentFields => ({ description: '', quantity: '', unitPrice: '', lineTotal: '' });
const emptyItem = (): ItemFields => ({ ...emptyComponent(), components: [] });
const fieldsFromItem = (item: ExpenseItem): ItemFields => ({
  description: item.description ?? '', quantity: item.quantity ?? '',
  unitPrice: centsToDecimal(item.unitPriceCents), lineTotal: centsToDecimal(item.lineTotalCents),
  components: (item.components ?? []).map((component) => ({
    description: component.description ?? '', quantity: component.quantity ?? '',
    unitPrice: centsToDecimal(component.unitPriceCents), lineTotal: centsToDecimal(component.lineTotalCents),
  })),
});

function validateComponent(item: ComponentFields, path: string, errors: Record<string, string>) {
  const description = item.description.trim() || null;
  const quantity = item.quantity.trim() || null;
  const unitPriceCents = item.unitPrice.trim() === '' ? null : decimalToCents(item.unitPrice);
  const lineTotalCents = item.lineTotal.trim() === '' ? null : decimalToCents(item.lineTotal);
  if (unitPriceCents === undefined || (unitPriceCents !== null && unitPriceCents < 0)) errors[`${path}.unitPriceCents`] = 'Use a valid amount with no more than 2 decimal places.';
  if (lineTotalCents === undefined || (lineTotalCents !== null && lineTotalCents < 0)) errors[`${path}.lineTotalCents`] = 'Use a valid amount with no more than 2 decimal places.';
  if (!description && !quantity && unitPriceCents === null && lineTotalCents === null) return null;
  return { description, quantity, unitPriceCents: unitPriceCents ?? null, lineTotalCents: lineTotalCents ?? null };
}

function validateItems(items: ItemFields[]): { values?: ExpenseItem[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values = items.flatMap((item, index) => {
    const value = validateComponent(item, `items.${index}`, errors);
    const components = item.components.flatMap((component, componentIndex) => {
      const componentValue = validateComponent(component, `items.${index}.components.${componentIndex}`, errors);
      return componentValue ? [componentValue] : [];
    });
    if (!value && components.length === 0) return [];
    return [{ ...(value ?? { description: null, quantity: null, unitPriceCents: null, lineTotalCents: null }), components }];
  });
  return Object.keys(errors).length ? { errors } : { errors, values };
}

export function ConfirmReceiptScreen() {
  const { receiptId: id = '' } = useParams(); const navigate = useNavigate(); const { session } = useSession();
  const request = useMemo(() => createClient('', transport), []);
  const receiptsApi = useMemo(() => createReceiptsApi(request), [request]);
  const categoriesApi = useMemo(() => createCategoriesApi(request), [request]);
  const expensesApi = useMemo(() => createExpensesApi(request), [request]);
  const [receipt,setReceipt]=useState<Receipt>(); const [categories,setCategories]=useState<Category[]>([]);
  const [fields,setFields]=useState<ExpenseFields>(); const [errors,setErrors]=useState<Record<string,string>>({});
  const [items,setItems]=useState<ItemFields[]>([]);
  const [expandedComponents,setExpandedComponents]=useState<Record<number,boolean>>({});
  const [image,setImage]=useState<string>(); const [imageUnavailable,setImageUnavailable]=useState(false);
  const [expanded,setExpanded]=useState(false); const [saving,setSaving]=useState(false); const savingRef=useRef(false);
  const [fatal,setFatal]=useState<string>(); const [preview,setPreview]=useState(false);

  const loadCategories = async () => {
    const result=await session.authorized((token)=>categoriesApi.list(token));
    if(result.kind==='ok') setCategories(result.body); return result;
  };
  useEffect(()=>{ let cancelled=false; let objectUrl:string|undefined;
    // The receipt and its category list are this route's one-time load; nothing
    // is set before both requests are in flight. Reported here only since the
    // form moved out — a component-local component made the compiler bail on
    // this file, taking the diagnostic with it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void Promise.all([session.authorized((token)=>receiptsApi.list(token)),loadCategories()]).then(async ([result])=>{
      if(cancelled)return;
      if(result.kind!=='ok'){ if(!(result.kind==='error'&&result.status===401))setFatal(describeFailure(result)); return; }
      const found=result.body.find((item)=>item.id===id);
      if(!found){ navigate('/',{replace:true,state:{notice:'Receipt not found'}}); return; }
      if(found.expenseId){ navigate('/',{replace:true,state:{notice:'That receipt has already been filed.'}}); return; }
      setReceipt(found); const e=found.extraction; const readable=e&&e.status!=='failed'&&e.status!=='skipped';
      setFields({categoryId:'',total:readable?centsToDecimal(e.totalCents):'',purchasedOn:readable?(e.purchasedOn??''):todayInMalaysia(),merchantName:readable?(e.merchantName??''):'',purchasedAtTime:readable?(e.purchasedAtTime?.slice(0,5)??''):'',merchantTaxId:readable?(e.merchantTaxId??''):'',receiptNumber:readable?(e.receiptNumber??''):'',subtotal:readable?centsToDecimal(e.subtotalCents??null):'',tax:readable?centsToDecimal(e.taxCents??null):'',rounding:readable?centsToDecimal(e.roundingCents??null):'',currency:readable?(e.currency??''):'',paymentMethod:readable?(e.paymentMethod??''):'',note:''});
      setItems(readable ? (e.items ?? []).map(fieldsFromItem) : []);
      const file=await session.authorized((token)=>receiptsApi.image(token,id)); if(cancelled)return;
      if(file.kind==='ok'){ objectUrl=URL.createObjectURL(file.body);setImage(objectUrl); }
      else if(file.kind==='error'&&file.status===404)navigate('/',{replace:true,state:{notice:'Receipt not found'}}); else if(!(file.kind==='error'&&file.status===401))setImageUnavailable(true);
    }); return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)};
  // APIs are stable memoized values; loadCategories intentionally belongs to this one-time route load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[id,navigate,receiptsApi,session]);

  function change(name:keyof ExpenseFields,value:string){setFields((current)=>current?{...current,[name]:value}:current);setErrors((current)=>{const next={...current};delete next[name];return next})}
  function changeItem(index:number,name:keyof ComponentFields,value:string){setItems((current)=>current.map((item,i)=>i===index?{...item,[name]:value}:item));setErrors((current)=>{const next={...current};delete next[`items.${index}.${name === 'unitPrice' ? 'unitPriceCents' : name === 'lineTotal' ? 'lineTotalCents' : name}`];return next})}
  function changeComponent(index:number,componentIndex:number,name:keyof ComponentFields,value:string){setItems((current)=>current.map((item,i)=>i===index?{...item,components:item.components.map((component,j)=>j===componentIndex?{...component,[name]:value}:component)}:item));setErrors((current)=>{const next={...current};delete next[`items.${index}.components.${componentIndex}.${name === 'unitPrice' ? 'unitPriceCents' : name === 'lineTotal' ? 'lineTotalCents' : name}`];return next})}
  const addItem=()=>setItems((current)=>[...current,emptyItem()]);
  const removeItem=(index:number)=>setItems((current)=>current.filter((_,i)=>i!==index));
  const addComponent=(index:number)=>{setItems((current)=>current.map((item,i)=>i===index?{...item,components:[...item.components,emptyComponent()]}:item));setExpandedComponents((current)=>({...current,[index]:true}))};
  const removeComponent=(index:number,componentIndex:number)=>setItems((current)=>current.map((item,i)=>i===index?{...item,components:item.components.filter((_,j)=>j!==componentIndex)}:item));
  async function save(event:FormEvent){event.preventDefault();if(savingRef.current||!fields)return;const checked=validateExpense(fields);const itemChecked=validateItems(items);setErrors({...checked.errors,...itemChecked.errors});if(!checked.values||!itemChecked.values)return;const body={...checked.values,items:itemChecked.values,receiptId:id};savingRef.current=true;setSaving(true);const result=await session.authorized((token)=>expensesApi.create(token,body));
    if(result.kind==='ok'){const category=categories.find((item)=>item.id===fields!.categoryId)?.name??'category';const subject=fields!.merchantName||receipt?.originalFilename||'Receipt';navigate('/',{replace:true,state:{notice:`Filed ${subject}, RM ${Number(fields!.total).toFixed(2)} under ${category}.`}});return;}
    savingRef.current=false;setSaving(false);if(result.kind==='error'&&result.status===400&&result.fields){setErrors(result.fields);if(Object.keys(result.fields).some((key)=>COLLAPSED_KEYS.has(key)))setExpanded(true);}
    else if(result.kind==='error'&&result.status===422&&result.message==='Category not found'){await loadCategories();setErrors({categoryId:'That category is no longer available. Choose another.'});}
    else if((result.kind==='error'&&((result.status===422&&result.message==='Receipt not found')||result.status===409)))navigate('/',{replace:true,state:{notice:result.status===409?'That receipt has already been filed.':'Receipt not found'}});
    else if(!(result.kind==='error'&&result.status===401))setErrors({form:describeFailure(result)});
  }
  if(fatal)return <main className="mx-auto max-w-xl p-4"><Alert variant="destructive"><AlertDescription>{fatal}</AlertDescription></Alert></main>;
  if(!fields||!receipt)return <main className="flex min-h-dvh items-center justify-center" aria-busy="true">Loading…</main>;
  const e=receipt.extraction; const unread=!e||e.status==='failed'||e.status==='skipped';
  const subtotalCents=decimalToCents(fields.subtotal);
  const reconciliationTarget=subtotalCents === undefined ? decimalToCents(fields.total) : subtotalCents;
  const reconciliationRows=[...items,...items.flatMap((item)=>item.components.filter((component)=>component.unitPrice.trim()!==''||component.lineTotal.trim()!==''))];
  const lineTotals=reconciliationRows.map((item)=>item.lineTotal.trim()===''?undefined:decimalToCents(item.lineTotal));
  const hasMismatch=reconciliationRows.length>0&&reconciliationTarget!==undefined&&lineTotals.every((value)=>value!==undefined)&&lineTotals.reduce((sum,value)=>sum+value!,0)!==reconciliationTarget;
  return <main className="mx-auto min-h-dvh w-full max-w-xl px-4 pb-28"><header className="flex items-center gap-2 py-3"><Button type="button" variant="ghost" size="icon" className="size-11" onClick={()=>navigate('/')} aria-label="Back"><ChevronLeft/></Button><h1 className="font-heading text-lg font-semibold">Confirm receipt</h1></header>
    {image?<button type="button" className="mb-5 block min-h-44 w-full overflow-hidden rounded-xl bg-muted" onClick={()=>setPreview(true)}><img className="max-h-80 w-full object-contain" src={image} alt="Receipt"/></button>:imageUnavailable?<div className="mb-5 flex min-h-44 items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">Receipt image is unavailable</div>:null}
    {unread&&<p className="mb-4 text-sm text-muted-foreground">We couldn't read this receipt — enter the details yourself.</p>}
    {e?.isReceipt===false&&<Alert className="mb-4"><AlertDescription>This doesn't look like a receipt. Check the photo before saving.</AlertDescription></Alert>}
    {errors.form&&<Alert variant="destructive" className="mb-4" role="alert"><AlertDescription>{errors.form}</AlertDescription></Alert>}
    <ExpenseForm fields={fields} errors={errors} categories={categories} expanded={expanded} onToggleDetails={()=>setExpanded(x=>!x)} onChange={change} onSubmit={save} submitLabel="Save expense" saving={saving} canSubmit={Boolean(fields.categoryId)} detailsExtra={items.length===0?<Button type="button" variant="outline" onClick={addItem}><Plus/>Add item</Button>:undefined}/>
    {items.length>0&&<section className="mt-5 grid gap-4 rounded-xl border p-4"><div className="flex items-center justify-between"><h2 className="font-heading font-semibold">Items</h2><Button type="button" variant="outline" onClick={addItem}><Plus/>Add item</Button></div>{items.map((item,index)=><div key={index} className="grid gap-3 rounded-lg border p-3"><div className="flex items-center justify-between"><span className="text-sm font-medium">Item {index+1}</span><Button type="button" variant="ghost" size="icon" aria-label={`Remove item ${index+1}`} onClick={()=>removeItem(index)}><Trash2/></Button></div><ItemInput label="Description" value={item.description} error={errors[`items.${index}.description`]} onChange={(value)=>changeItem(index,'description',value)}/><ItemInput label="Quantity" value={item.quantity} error={errors[`items.${index}.quantity`]} onChange={(value)=>changeItem(index,'quantity',value)}/><ItemInput label="Unit price" inputMode="decimal" value={item.unitPrice} error={errors[`items.${index}.unitPriceCents`]} onChange={(value)=>changeItem(index,'unitPrice',value)}/><ItemInput label="Line total" inputMode="decimal" value={item.lineTotal} error={errors[`items.${index}.lineTotalCents`]} onChange={(value)=>changeItem(index,'lineTotal',value)}/><div className="flex gap-2"><Button type="button" variant="outline" onClick={()=>addComponent(index)}><Plus/>Add component</Button>{item.components.length>0&&<Button type="button" variant="ghost" aria-expanded={Boolean(expandedComponents[index])} onClick={()=>setExpandedComponents((current)=>({...current,[index]:!current[index]}))}>{item.components.length} {item.components.length===1?'component':'components'}</Button>}</div>{expandedComponents[index]&&item.components.map((component,componentIndex)=><div key={componentIndex} className="grid gap-3 rounded-lg border p-3"><div className="flex items-center justify-between"><span className="text-sm font-medium">Component {componentIndex+1}</span><Button type="button" variant="ghost" size="icon" aria-label={`Remove component ${componentIndex+1} from item ${index+1}`} onClick={()=>removeComponent(index,componentIndex)}><Trash2/></Button></div><ItemInput label={`Component ${componentIndex+1} description`} value={component.description} error={errors[`items.${index}.components.${componentIndex}.description`]} onChange={(value)=>changeComponent(index,componentIndex,'description',value)}/><ItemInput label={`Component ${componentIndex+1} quantity`} value={component.quantity} error={errors[`items.${index}.components.${componentIndex}.quantity`]} onChange={(value)=>changeComponent(index,componentIndex,'quantity',value)}/><ItemInput label={`Component ${componentIndex+1} unit price`} inputMode="decimal" value={component.unitPrice} error={errors[`items.${index}.components.${componentIndex}.unitPriceCents`]} onChange={(value)=>changeComponent(index,componentIndex,'unitPrice',value)}/><ItemInput label={`Component ${componentIndex+1} line total`} inputMode="decimal" value={component.lineTotal} error={errors[`items.${index}.components.${componentIndex}.lineTotalCents`]} onChange={(value)=>changeComponent(index,componentIndex,'lineTotal',value)}/></div>)}</div>)}{hasMismatch&&<Alert><AlertDescription>Item line totals do not match the receipt {fields.subtotal.trim() ? 'subtotal' : 'total'}. You can still save after checking the amounts.</AlertDescription></Alert>}</section>}
    {preview&&image&&<div className="fixed inset-0 z-50 flex bg-black/90 p-4" role="dialog" aria-modal="true"><button className="absolute right-4 top-4 min-h-11 rounded-lg bg-white px-4 text-black" onClick={()=>setPreview(false)}>Close</button><img className="m-auto max-h-full max-w-full object-contain" src={image} alt="Receipt full screen"/></div>}</main>;
}

function ItemInput({ label, value, error, onChange, inputMode }: { label:string; value:string; error?:string; onChange:(value:string)=>void; inputMode?:'decimal' }) {
  return <div className="grid gap-2"><label className="text-sm font-medium">{label}</label><input aria-label={label} inputMode={inputMode} value={value} onChange={(event)=>onChange(event.target.value)} className="h-11 w-full rounded-lg border bg-transparent px-2.5 text-base"/>{error&&<p className="text-sm text-destructive" role="alert">{error}</p>}</div>;
}
