import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { createClient } from '@/api/client';
import { createCategoriesApi, type Category } from '@/api/categories';
import { createExpensesApi, type ExpenseInput } from '@/api/expenses';
import { createReceiptsApi, type Receipt } from '@/api/receipts';
import { describeFailure } from '@/api/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/session/context';
import { centsToDecimal, decimalToCents, todayInMalaysia } from '@/lib/money';

type Fields = { categoryId:string; total:string; purchasedOn:string; merchantName:string; purchasedAtTime:string; merchantTaxId:string; receiptNumber:string; subtotal:string; tax:string; rounding:string; currency:string; paymentMethod:string; note:string };
const hidden = new Set(['purchasedAtTime','merchantTaxId','receiptNumber','subtotalCents','taxCents','roundingCents','currency','paymentMethod','note']);
const transport = (url: string, init: RequestInit) => fetch(url, init);

export function ConfirmReceiptScreen() {
  const { id = '' } = useParams(); const navigate = useNavigate(); const { session } = useSession();
  const request = useMemo(() => createClient('', transport), []);
  const receiptsApi = useMemo(() => createReceiptsApi(request), [request]);
  const categoriesApi = useMemo(() => createCategoriesApi(request), [request]);
  const expensesApi = useMemo(() => createExpensesApi(request), [request]);
  const [receipt,setReceipt]=useState<Receipt>(); const [categories,setCategories]=useState<Category[]>([]);
  const [fields,setFields]=useState<Fields>(); const [errors,setErrors]=useState<Record<string,string>>({});
  const [image,setImage]=useState<string>(); const [imageUnavailable,setImageUnavailable]=useState(false);
  const [expanded,setExpanded]=useState(false); const [saving,setSaving]=useState(false); const savingRef=useRef(false);
  const [fatal,setFatal]=useState<string>(); const [preview,setPreview]=useState(false);

  const loadCategories = async () => {
    const result=await session.authorized((token)=>categoriesApi.list(token));
    if(result.kind==='ok') setCategories(result.body); return result;
  };
  useEffect(()=>{ let cancelled=false; let objectUrl:string|undefined;
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

  function change(name:keyof Fields,value:string){setFields((current)=>current?{...current,[name]:value}:current);setErrors((current)=>{const next={...current};delete next[name];return next})}
  function validate(): {body?:ExpenseInput; errors:Record<string,string>} {
    if(!fields)return{errors:{}}; const next:Record<string,string>={};
    if(!fields.categoryId)next.categoryId='Choose a category.'; if(!fields.purchasedOn)next.purchasedOn='Date is required.'; else if(fields.purchasedOn>todayInMalaysia())next.purchasedOn='Date cannot be in the future.';
    const money=(key:keyof Pick<Fields,'total'|'subtotal'|'tax'|'rounding'>,apiKey:string,required=false,positive=false)=>{const raw=fields[key];if(!raw&&!required)return null;const cents=decimalToCents(raw);if(cents===undefined)next[apiKey]='Use a valid amount with no more than 2 decimal places.';else if(positive&&cents<=0)next[apiKey]='Total must be greater than zero.';else if((key==='subtotal'||key==='tax')&&cents<0)next[apiKey]='Amount cannot be negative.';return cents};
    const total=money('total','totalCents',true,true),subtotal=money('subtotal','subtotalCents'),tax=money('tax','taxCents'),rounding=money('rounding','roundingCents'); if(Object.keys(next).length)return{errors:next};
    return{errors:next,body:{categoryId:fields.categoryId,receiptId:id,totalCents:total!,purchasedOn:fields.purchasedOn,purchasedAtTime:fields.purchasedAtTime||null,subtotalCents:subtotal,taxCents:tax,roundingCents:rounding,...(fields.currency?{currency:fields.currency}:{}),merchantName:fields.merchantName||null,merchantTaxId:fields.merchantTaxId||null,receiptNumber:fields.receiptNumber||null,paymentMethod:fields.paymentMethod||null,note:fields.note||null}};
  }
  async function save(event:FormEvent){event.preventDefault();if(savingRef.current)return;const checked=validate();setErrors(checked.errors);if(!checked.body)return;savingRef.current=true;setSaving(true);const result=await session.authorized((token)=>expensesApi.create(token,checked.body!));
    if(result.kind==='ok'){const category=categories.find((item)=>item.id===fields!.categoryId)?.name??'category';const subject=fields!.merchantName||receipt?.originalFilename||'Receipt';navigate('/',{replace:true,state:{notice:`Filed ${subject}, RM ${Number(fields!.total).toFixed(2)} under ${category}.`}});return;}
    savingRef.current=false;setSaving(false);if(result.kind==='error'&&result.status===400&&result.fields){setErrors(result.fields);if(Object.keys(result.fields).some((key)=>hidden.has(key)))setExpanded(true);}
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
    <form onSubmit={save} className="grid gap-4"><Field label="Category" error={errors.categoryId}><select aria-label="Category" value={fields.categoryId} onChange={(x)=>change('categoryId',x.target.value)} className="h-11 w-full rounded-lg border bg-background px-2.5 text-base"><option value="">Choose a category</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Total" error={errors.totalCents}><Input aria-label="Total" inputMode="decimal" value={fields.total} onChange={x=>change('total',x.target.value)}/></Field>
      <Field label="Date" error={errors.purchasedOn}><Input aria-label="Date" type="date" max={todayInMalaysia()} value={fields.purchasedOn} onChange={x=>change('purchasedOn',x.target.value)}/></Field>
      <Field label="Merchant" error={errors.merchantName}><Input aria-label="Merchant" value={fields.merchantName} onChange={x=>change('merchantName',x.target.value)}/></Field>
      <Button type="button" variant="outline" className="h-11" onClick={()=>setExpanded(x=>!x)} aria-expanded={expanded}>More details</Button>
      {expanded&&<div className="grid gap-4 rounded-xl border p-4"><TextField label="Time" name="purchasedAtTime" type="time"/><TextField label="Tax ID" name="merchantTaxId"/><TextField label="Receipt number" name="receiptNumber"/><TextField label="Subtotal" name="subtotal" money api="subtotalCents"/><TextField label="Tax" name="tax" money api="taxCents"/><TextField label="Rounding" name="rounding" money api="roundingCents"/><TextField label="Currency" name="currency"/><TextField label="Payment method" name="paymentMethod"/><TextField label="Note" name="note"/></div>}
      <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 px-4 pt-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]"><Button className="mx-auto h-12 w-full max-w-xl" type="submit" disabled={!fields.categoryId||saving}>{saving?'Saving…':'Save expense'}</Button></div>
    </form>{preview&&image&&<div className="fixed inset-0 z-50 flex bg-black/90 p-4" role="dialog" aria-modal="true"><button className="absolute right-4 top-4 min-h-11 rounded-lg bg-white px-4 text-black" onClick={()=>setPreview(false)}>Close</button><img className="m-auto max-h-full max-w-full object-contain" src={image} alt="Receipt full screen"/></div>}</main>;
  function TextField({label,name,type='text',money=false,api}:{label:string;name:keyof Fields;type?:string;money?:boolean;api?:string}){return <Field label={label} error={errors[api??name]}><Input aria-label={label} type={type} inputMode={money?'decimal':undefined} value={fields![name]} onChange={x=>change(name,x.target.value)}/></Field>}
}
function Field({label,error,children}:{label:string;error?:string;children:React.ReactNode}){return <div className="grid gap-2"><Label>{label}</Label>{children}{error&&<p className="text-sm text-destructive" role="alert">{error}</p>}</div>}
