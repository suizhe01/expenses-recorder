import { Link } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { CLIENT_ROUTES } from '@/client-routes';
import { Button } from '@/components/ui/button';
import { useSession } from '@/session/context';

export function SettingsScreen() {
  const { state, session } = useSession();
  const email = state.status === 'signed-in' ? state.user.email : '';
  return <main className="mx-auto min-h-dvh w-full max-w-xl px-4 pb-8">{/*
      Settings carries no TabBar, so without this control the screen is a dead
      end reachable only by browser back. A Link rather than navigate(-1): the
      screen is a real route, so a direct load or a reload has no history to pop
      and the button would do nothing. Same pattern as the Categories header.
    */}
    <header className="flex items-center gap-2 border-b py-3 dark:border-border"><Button asChild variant="ghost" size="icon" className="size-11" aria-label="Back"><Link to={CLIENT_ROUTES.home}><ChevronLeft /></Link></Button><div className="min-w-0"><h1 className="font-heading text-lg font-semibold">Settings</h1><p className="truncate text-sm text-muted-foreground">{email}</p></div></header><section className="mt-5 grid gap-2"><Link to={CLIENT_ROUTES.categories} className="flex min-h-11 items-center justify-between rounded-xl border px-4 dark:border-border"><span className="font-medium">Categories</span><ChevronRight className="size-5 text-muted-foreground" aria-hidden="true" /></Link><Link to={CLIENT_ROUTES.merchantCorrections} className="flex min-h-11 items-center justify-between rounded-xl border px-4 dark:border-border"><span className="font-medium">Merchant corrections</span><ChevronRight className="size-5 text-muted-foreground" aria-hidden="true" /></Link><Button variant="outline" className="mt-3 h-11" onClick={() => void session.signOut()}>Sign out</Button></section></main>;
}
