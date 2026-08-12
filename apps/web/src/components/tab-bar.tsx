import { Inbox, WalletCards } from 'lucide-react';
import { Link } from 'react-router';
import { CLIENT_ROUTES } from '@/client-routes';
import { cn } from '@/lib/utils';

const tabs = [{ to: CLIENT_ROUTES.home, label: 'Inbox', icon: Inbox }, { to: CLIENT_ROUTES.expenses, label: 'Expenses', icon: WalletCards }];

export function TabBar({ active }: { active: 'inbox' | 'expenses' }) {
  return <nav aria-label="Main navigation" className="fixed inset-x-0 bottom-0 z-30 h-[calc(4rem+env(safe-area-inset-bottom))] border-t bg-background/95 px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur dark:border-border">
    <div className="mx-auto grid max-w-xl grid-cols-2 gap-2">{tabs.map(({ to, label, icon: Icon }) => {
      const isActive = (active === 'inbox' && to === CLIENT_ROUTES.home) || (active === 'expenses' && to === CLIENT_ROUTES.expenses);
      return <Link key={to} to={to} aria-current={isActive ? 'page' : undefined} className={cn('flex min-h-11 items-center justify-center gap-2 rounded-lg text-sm font-medium', isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted dark:hover:bg-muted/70')}><Icon className="size-4" aria-hidden="true" />{label}</Link>;
    })}</div>
  </nav>;
}
