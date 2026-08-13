import { CirclePlus, LayoutDashboard, WalletCards } from 'lucide-react';
import { Link } from 'react-router';
import { CLIENT_ROUTES } from '@/client-routes';
import { cn } from '@/lib/utils';

const tabs = [{ to: CLIENT_ROUTES.home, label: 'Overview', icon: LayoutDashboard }, { to: CLIENT_ROUTES.expenses, label: 'Expenses', icon: WalletCards }];

export function TabBar({ active, capture = true }: { active: 'overview' | 'expenses' | 'inbox'; capture?: boolean }) {
  return <nav aria-label="Main navigation" className="fixed inset-x-0 bottom-0 z-30 h-[calc(4rem+env(safe-area-inset-bottom))] border-t bg-background/95 px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur dark:border-border"><div className="relative mx-auto grid max-w-xl grid-cols-2 gap-2">{tabs.map(({ to, label, icon: Icon }) => { const isActive = (active === 'overview' || active === 'inbox') ? to === CLIENT_ROUTES.home : to === CLIENT_ROUTES.expenses; return <Link key={to} to={to} aria-current={isActive ? 'page' : undefined} className={cn('flex min-h-11 items-center justify-center gap-2 rounded-lg text-sm font-medium', isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted dark:hover:bg-muted/70')}><Icon className="size-4" aria-hidden="true" />{label}</Link>; })}{capture&&<Link to={CLIENT_ROUTES.add} className="absolute left-1/2 top-0 flex size-14 -translate-x-1/2 -translate-y-5 items-center justify-center rounded-full border-4 border-background bg-primary text-primary-foreground shadow-lg" aria-label="Add expense"><CirclePlus className="size-7" aria-hidden="true" /></Link>}</div></nav>;
}
