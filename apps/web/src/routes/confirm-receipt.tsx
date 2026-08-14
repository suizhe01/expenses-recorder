import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { createClient } from '@/api/client';
import type { ApiFailure, ApiOffline } from '@/api/client';
import { createCategoriesApi, type Category } from '@/api/categories';
import { createExpensesApi } from '@/api/expenses';
import { createReceiptsApi, type Extraction, type Receipt } from '@/api/receipts';
import { describeFailure } from '@/api/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { COLLAPSED_KEYS, ExpenseForm, validateExpense, type ExpenseFields } from '@/components/expense-form';
import { useSession } from '@/session/context';
import { centsToDecimal, decimalToCents, todayInMalaysia } from '@/lib/money';
import { ItemsEditor, fieldsFromItem, type ItemFields, validateItems } from '@/components/items-editor';
import { createMerchantCorrectionsApi, normalizeMerchant, type MerchantCorrection } from '@/api/merchant-corrections';

const transport = (url: string, init: RequestInit) => fetch(url, init);

function fieldsFromExtraction(extraction: Extraction | null | undefined): ExpenseFields {
  const readable = extraction && extraction.status !== 'failed' && extraction.status !== 'skipped';
  return { categoryId: '', total: readable ? centsToDecimal(extraction.totalCents) : '', purchasedOn: readable ? (extraction.purchasedOn ?? '') : todayInMalaysia(), merchantName: readable ? (extraction.merchantName ?? '') : '', purchasedAtTime: readable ? (extraction.purchasedAtTime?.slice(0, 5) ?? '') : '', merchantTaxId: readable ? (extraction.merchantTaxId ?? '') : '', receiptNumber: readable ? (extraction.receiptNumber ?? '') : '', subtotal: readable ? centsToDecimal(extraction.subtotalCents ?? null) : '', tax: readable ? centsToDecimal(extraction.taxCents ?? null) : '', rounding: readable ? centsToDecimal(extraction.roundingCents ?? null) : '', currency: readable ? (extraction.currency ?? '') : '', paymentMethod: readable ? (extraction.paymentMethod ?? '') : '', note: '' };
}

function itemsFromExtraction(extraction: Extraction | null | undefined): ItemFields[] {
  return extraction && extraction.status !== 'failed' && extraction.status !== 'skipped' ? (extraction.items ?? []).map(fieldsFromItem) : [];
}

export function ConfirmReceiptScreen() {
  const { receiptId: id = '' } = useParams(); const navigate = useNavigate(); const { session } = useSession();
  const request = useMemo(() => createClient('', transport), []);
  const receiptsApi = useMemo(() => createReceiptsApi(request), [request]);
  const categoriesApi = useMemo(() => createCategoriesApi(request), [request]);
  const expensesApi = useMemo(() => createExpensesApi(request), [request]);
  const correctionsApi = useMemo(() => createMerchantCorrectionsApi(request), [request]);
  const [receipt,setReceipt]=useState<Receipt>(); const [categories,setCategories]=useState<Category[]>([]);
  const [fields,setFields]=useState<ExpenseFields>(); const [errors,setErrors]=useState<Record<string,string>>({});
  const [items,setItems]=useState<ItemFields[]>([]);
  const [image,setImage]=useState<string>(); const [imageBlob,setImageBlob]=useState<Blob>(); const [imageUnavailable,setImageUnavailable]=useState(false);
  const [expanded,setExpanded]=useState(false); const [saving,setSaving]=useState(false); const savingRef=useRef(false);
  const [fatal,setFatal]=useState<string>(); const [preview,setPreview]=useState(false); const [retrying,setRetrying]=useState(false); const retryingRef=useRef(false);
  const [corrections,setCorrections]=useState<MerchantCorrection[]>([]); const [remember,setRemember]=useState(false); const saveChoiceRef=useRef<'ask'|'only'|'remember'>('ask');
  const [retryMessage,setRetryMessage]=useState<string>(); const [pendingReading,setPendingReading]=useState<Receipt>();
  const initialFields=useRef<ExpenseFields | undefined>(undefined); const initialItems=useRef<ItemFields[]>([]);

  function applyReading(next: Receipt) {
    const nextFields = fieldsFromExtraction(next.extraction); const nextItems = itemsFromExtraction(next.extraction);
    setReceipt(next); setFields(nextFields); setItems(nextItems); initialFields.current=nextFields; initialItems.current=nextItems; setErrors({}); setRetryMessage(undefined);
  }

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
    void Promise.all([session.authorized((token)=>receiptsApi.list(token)),loadCategories(),session.authorized((token)=>correctionsApi.list(token))]).then(async ([result,,correctionResult])=>{
      if(cancelled)return;
      if(result.kind!=='ok'){ if(!(result.kind==='error'&&result.status===401))setFatal(describeFailure(result)); return; }
      const found=result.body.find((item)=>item.id===id);
      if(!found){ navigate('/',{replace:true,state:{notice:'Receipt not found'}}); return; }
      if(found.expenseId){ navigate('/',{replace:true,state:{notice:'That receipt has already been filed.'}}); return; }
      applyReading(found);
      if(correctionResult.kind==='ok')setCorrections(correctionResult.body);
      const file=await session.authorized((token)=>receiptsApi.image(token,id)); if(cancelled)return;
      if(file.kind==='ok'){ objectUrl=URL.createObjectURL(file.body);setImage(objectUrl);setImageBlob(file.body); }
      else if(file.kind==='error'&&file.status===404)navigate('/',{replace:true,state:{notice:'Receipt not found'}}); else if(!(file.kind==='error'&&file.status===401))setImageUnavailable(true);
    }); return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)};
  // APIs are stable memoized values; loadCategories intentionally belongs to this one-time route load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[correctionsApi,id,navigate,receiptsApi,session]);

  function change(name:keyof ExpenseFields,value:string){setFields((current)=>current?{...current,[name]:value}:current);setErrors((current)=>{const next={...current};delete next[name];return next})}
  function hasEdits() { return JSON.stringify(fields) !== JSON.stringify(initialFields.current) || JSON.stringify(items) !== JSON.stringify(initialItems.current); }
  function retryFailureMessage(result: ApiFailure | ApiOffline) {
    if (result.kind === 'offline') return result.message;
    if (result.kind === 'error' && result.status === 429) return result.retryAfterSeconds === undefined ? 'Too many uploads. Please wait a moment and try again.' : `Too many uploads. Try again in ${result.retryAfterSeconds} ${result.retryAfterSeconds === 1 ? 'second' : 'seconds'}.`;
    return describeFailure(result);
  }
  async function retryReading() {
    if (retryingRef.current || !imageBlob || !receipt) return;
    retryingRef.current=true; setRetrying(true); setRetryMessage(undefined);
    const file = new File([imageBlob], receipt.originalFilename ?? 'receipt', { type: receipt.contentType });
    const result=await session.authorized((token)=>receiptsApi.upload(token,file));
    retryingRef.current=false; setRetrying(false);
    if(result.kind==='ok'){
      if(result.body.id!==id){setRetryMessage('The new reading did not match this receipt. Nothing was changed.');return;}
      if(result.body.expenseId){navigate('/',{replace:true,state:{notice:'That receipt has already been filed.'}});return;}
      if(!result.body.extraction||result.body.extraction.status==='failed'||result.body.extraction.status==='skipped'){setReceipt(result.body);setRetryMessage('We tried again but still couldn’t read this receipt. Enter the details yourself.');return;}
      if(hasEdits()){setPendingReading(result.body);return;}
      applyReading(result.body);return;
    }
    if(!(result.kind==='error'&&result.status===401))setRetryMessage(retryFailureMessage(result));
  }
  const detected=receipt?.extraction?.merchantName ?? ''; const suggestion=detected?corrections.find((rule)=>normalizeMerchant(rule.detectedName)===normalizeMerchant(detected)):undefined;
  async function save(event:FormEvent){event.preventDefault();if(savingRef.current||!fields)return;const choice=saveChoiceRef.current;saveChoiceRef.current='ask';const checked=validateExpense(fields);const itemChecked=validateItems(items);setErrors({...checked.errors,...itemChecked.errors});if(!checked.values||!itemChecked.values)return; const covered=Boolean(suggestion&&suggestion.merchantName===fields.merchantName&&suggestion.categoryId===fields.categoryId); if(detected&&(fields.merchantName.trim()!==detected.trim()||fields.categoryId!==suggestion?.categoryId)&&!covered&&choice==='ask'){setRemember(true);return;} const body={...checked.values,items:itemChecked.values,receiptId:id};savingRef.current=true;setSaving(true);if(choice==='remember'&&detected){const correction={detectedName:detected,merchantName:fields.merchantName,categoryId:fields.categoryId};const correctionResult=await session.authorized((token)=>suggestion?correctionsApi.update(token,suggestion.id,correction):correctionsApi.create(token,correction));if(correctionResult.kind!=='ok'){savingRef.current=false;setSaving(false);setErrors({form:'Could not save merchant correction. Your expense has not been filed.'});return;}}const result=await session.authorized((token)=>expensesApi.create(token,body));
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
  return <main className="mx-auto min-h-dvh w-full max-w-xl px-4 pb-28"><header className="flex items-center gap-2 py-3"><Button type="button" variant="ghost" size="icon" className="size-11" onClick={()=>navigate('/')} aria-label="Back"><ChevronLeft/></Button><h1 className="font-heading text-lg font-semibold">Confirm receipt</h1></header>
    {image?<button type="button" className="mb-5 block min-h-44 w-full overflow-hidden rounded-xl bg-muted" onClick={()=>setPreview(true)}><img className="max-h-80 w-full object-contain" src={image} alt="Receipt"/></button>:imageUnavailable?<div className="mb-5 flex min-h-44 items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">Receipt image is unavailable</div>:null}
    {e?.source&&<p className="mb-4 text-sm text-muted-foreground">{e.source==='PaddleOCR'?'Read locally with PaddleOCR.':e.source==='PaddleOCR-assisted Gemini'?'Read with PaddleOCR-assisted Gemini.':'Read with Gemini fallback.'}</p>}
    {suggestion&&<Alert className="mb-4"><AlertDescription>Saved correction: {suggestion.merchantName}{suggestion.categoryActive?` · ${suggestion.categoryName}`:' · Saved category is unavailable; choose a category.'}<Button type="button" variant="outline" className="ml-2" onClick={()=>{change('merchantName',suggestion.merchantName);if(suggestion.categoryActive)change('categoryId',suggestion.categoryId);}}>Use saved correction</Button></AlertDescription></Alert>}
    {unread&&<div className="mb-4 flex flex-wrap items-center gap-2"><p className="text-sm text-muted-foreground">We couldn't read this receipt — enter the details yourself.</p>{imageBlob&&<Button type="button" variant="outline" className="h-11" disabled={retrying} onClick={()=>void retryReading()}>{retrying?'Trying again…':'Try again'}</Button>}</div>}
    {retryMessage&&<Alert variant="destructive" className="mb-4" role="alert"><AlertDescription>{retryMessage}</AlertDescription></Alert>}
    {e?.isReceipt===false&&<Alert className="mb-4"><AlertDescription>This doesn't look like a receipt. Check the photo before saving.</AlertDescription></Alert>}
    {errors.form&&<Alert variant="destructive" className="mb-4" role="alert"><AlertDescription>{errors.form}</AlertDescription></Alert>}
    <ExpenseForm formId="confirm-expense-form" fields={fields} errors={errors} categories={categories} expanded={expanded} onToggleDetails={()=>setExpanded(x=>!x)} onChange={change} onSubmit={save} submitLabel="Save expense" saving={saving} canSubmit={Boolean(fields.categoryId)} detailsExtra={items.length===0?<ItemsEditor items={items} setItems={setItems} errors={errors} clearItemErrors={()=>setErrors(current=>Object.fromEntries(Object.entries(current).filter(([key])=>!key.startsWith('items.'))))}/>:undefined}/>
    {items.length>0&&(
      <ItemsEditor items={items} setItems={setItems} errors={errors} targetCents={reconciliationTarget} targetName={fields.subtotal.trim()?'subtotal':'total'} clearItemErrors={()=>setErrors(current=>Object.fromEntries(Object.entries(current).filter(([key])=>!key.startsWith('items.'))))}/>
    )}
    {preview&&image&&<div className="fixed inset-0 z-50 flex bg-black/90 p-4" role="dialog" aria-modal="true"><button className="absolute right-4 top-4 min-h-11 rounded-lg bg-white px-4 text-black" onClick={()=>setPreview(false)}>Close</button><img className="m-auto max-h-full max-w-full object-contain" src={image} alt="Receipt full screen"/></div>}
    <Dialog open={Boolean(pendingReading)} onOpenChange={(open)=>{if(!open)setPendingReading(undefined)}}><DialogContent><DialogHeader><DialogTitle>Replace typed values?</DialogTitle><DialogDescription>A new reading is ready. Applying it will replace the values you typed.</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={()=>setPendingReading(undefined)}>Cancel</Button><Button type="button" onClick={()=>{if(pendingReading)applyReading(pendingReading);setPendingReading(undefined)}}>Replace values</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={remember} onOpenChange={setRemember}><DialogContent><DialogHeader><DialogTitle>Remember this correction?</DialogTitle><DialogDescription>Save this merchant and category suggestion for the detected name “{detected}”?</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={()=>{saveChoiceRef.current='only';setRemember(false);(document.getElementById('confirm-expense-form') as HTMLFormElement | null)?.requestSubmit();}}>Save only</Button><Button type="button" onClick={()=>{saveChoiceRef.current='remember';setRemember(false);(document.getElementById('confirm-expense-form') as HTMLFormElement | null)?.requestSubmit();}}>Save and remember</Button></DialogFooter></DialogContent></Dialog>
    </main>;
}
