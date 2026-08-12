import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { createClient } from '@/api/client';
import { createCategoriesApi, type Category } from '@/api/categories';
import { createExpensesApi } from '@/api/expenses';
import { createReceiptsApi, type Receipt } from '@/api/receipts';
import { describeFailure } from '@/api/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { COLLAPSED_KEYS, ExpenseForm, validateExpense, type ExpenseFields } from '@/components/expense-form';
import { useSession } from '@/session/context';
import { centsToDecimal, todayInMalaysia } from '@/lib/money';

const transport = (url: string, init: RequestInit) => fetch(url, init);

export function ConfirmReceiptScreen() {
  const { receiptId: id = '' } = useParams(); const navigate = useNavigate(); const { session } = useSession();
  const request = useMemo(() => createClient('', transport), []);
  const receiptsApi = useMemo(() => createReceiptsApi(request), [request]);
  const categoriesApi = useMemo(() => createCategoriesApi(request), [request]);
  const expensesApi = useMemo(() => createExpensesApi(request), [request]);
  const [receipt,setReceipt]=useState<Receipt>(); const [categories,setCategories]=useState<Category[]>([]);
  const [fields,setFields]=useState<ExpenseFields>(); const [errors,setErrors]=useState<Record<string,string>>({});
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
      const file=await session.authorized((token)=>receiptsApi.image(token,id)); if(cancelled)return;
      if(file.kind==='ok'){ objectUrl=URL.createObjectURL(file.body);setImage(objectUrl); }
      else if(file.kind==='error'&&file.status===404)navigate('/',{replace:true,state:{notice:'Receipt not found'}}); else if(!(file.kind==='error'&&file.status===401))setImageUnavailable(true);
    }); return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)};
  // APIs are stable memoized values; loadCategories intentionally belongs to this one-time route load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[id,navigate,receiptsApi,session]);

  function change(name:keyof ExpenseFields,value:string){setFields((current)=>current?{...current,[name]:value}:current);setErrors((current)=>{const next={...current};delete next[name];return next})}
  async function save(event:FormEvent){event.preventDefault();if(savingRef.current||!fields)return;const checked=validateExpense(fields);setErrors(checked.errors);if(!checked.values)return;const body={...checked.values,receiptId:id};savingRef.current=true;setSaving(true);const result=await session.authorized((token)=>expensesApi.create(token,body));
    if(result.kind==='ok'){const category=categories.find((item)=>item.id===fields!.categoryId)?.name??'category';const subject=fields!.merchantName||receipt?.originalFilename||'Receipt';navigate('/',{replace:true,state:{notice:`Filed ${subject}, RM ${Number(fields!.total).toFixed(2)} under ${category}.`}});return;}
    savingRef.current=false;setSaving(false);if(result.kind==='error'&&result.status===400&&result.fields){setErrors(result.fields);if(Object.keys(result.fields).some((key)=>COLLAPSED_KEYS.has(key)))setExpanded(true);}
    else if(result.kind==='error'&&result.status===422&&result.message==='Category not found'){await loadCategories();setErrors({categoryId:'That category is no longer available. Choose another.'});}
    else if((result.kind==='error'&&((result.status===422&&result.message==='Receipt not found')||result.status===409)))navigate('/',{replace:true,state:{notice:result.status===409?'That receipt has already been filed.':'Receipt not found'}});
    else if(!(result.kind==='error'&&result.status===401))setErrors({form:describeFailure(result)});
  }
  if(fatal)return <main className="mx-auto max-w-xl p-4"><Alert variant="destructive"><AlertDescription>{fatal}</AlertDescription></Alert></main>;
  if(!fields||!receipt)return <main className="flex min-h-dvh items-center justify-center" aria-busy="true">Loading…</main>;
  const e=receipt.extraction; const unread=!e||e.status==='failed'||e.status==='skipped';
  return <main className="mx-auto min-h-dvh w-full max-w-xl px-4 pb-28"><header className="flex items-center gap-2 py-3"><Button type="button" variant="ghost" size="icon" className="size-11" onClick={()=>navigate('/')} aria-label="Back"><ChevronLeft/></Button><h1 className="font-heading text-lg font-semibold">Confirm receipt</h1></header>
    {image?<button type="button" className="mb-5 block min-h-44 w-full overflow-hidden rounded-xl bg-muted" onClick={()=>setPreview(true)}><img className="max-h-80 w-full object-contain" src={image} alt="Receipt"/></button>:imageUnavailable?<div className="mb-5 flex min-h-44 items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">Receipt image is unavailable</div>:null}
    {unread&&<p className="mb-4 text-sm text-muted-foreground">We couldn't read this receipt — enter the details yourself.</p>}
    {e?.isReceipt===false&&<Alert className="mb-4"><AlertDescription>This doesn't look like a receipt. Check the photo before saving.</AlertDescription></Alert>}
    {errors.form&&<Alert variant="destructive" className="mb-4" role="alert"><AlertDescription>{errors.form}</AlertDescription></Alert>}
    <ExpenseForm fields={fields} errors={errors} categories={categories} expanded={expanded} onToggleDetails={()=>setExpanded(x=>!x)} onChange={change} onSubmit={save} submitLabel="Save expense" saving={saving} canSubmit={Boolean(fields.categoryId)}/>
    {preview&&image&&<div className="fixed inset-0 z-50 flex bg-black/90 p-4" role="dialog" aria-modal="true"><button className="absolute right-4 top-4 min-h-11 rounded-lg bg-white px-4 text-black" onClick={()=>setPreview(false)}>Close</button><img className="m-auto max-h-full max-w-full object-contain" src={image} alt="Receipt full screen"/></div>}</main>;
}
