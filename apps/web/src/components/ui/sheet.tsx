import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

function SheetContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 dark:bg-black/70" /><DialogPrimitive.Content className={cn('fixed inset-x-0 bottom-0 z-40 grid max-h-[min(80dvh,44rem)] gap-4 overflow-y-auto rounded-t-2xl border-t bg-background p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-foreground shadow-lg dark:border-border', className)} {...props}>{children}<DialogPrimitive.Close className="absolute top-3 right-3 flex size-11 items-center justify-center rounded-lg hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"><X aria-hidden="true" /><span className="sr-only">Close</span></DialogPrimitive.Close></DialogPrimitive.Content></DialogPrimitive.Portal>;
}

function SheetHeader(props: React.ComponentProps<'div'>) { return <div className="grid gap-2 pr-10" {...props} />; }
const SheetTitle = DialogPrimitive.Title;
function SheetDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) { return <DialogPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />; }
function SheetFooter(props: React.ComponentProps<'div'>) { return <div className="flex gap-2 [&>*]:min-h-11 [&>*]:flex-1" {...props} />; }

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter };
