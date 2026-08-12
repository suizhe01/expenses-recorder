import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { CLIENT_ROUTES } from '@/client-routes';
import { Button } from '@/components/ui/button';
import { useSession } from '@/session/context';

export function SettingsScreen() {
  const { state, session } = useSession();
  const email = state.status === 'signed-in' ? state.user.email : '';
  return <main className="mx-auto min-h-dvh w-full max-w-xl px-4 pb-8"><header className="border-b py-4 dark:border-border"><h1 className="font-heading text-lg font-semibold">Settings</h1><p className="truncate text-sm text-muted-foreground">{email}</p></header><section className="mt-5 grid gap-2"><Link to={CLIENT_ROUTES.categories} className="flex min-h-11 items-center justify-between rounded-xl border px-4 dark:border-border"><span className="font-medium">Categories</span><ChevronRight className="size-5 text-muted-foreground" aria-hidden="true" /></Link><Button variant="outline" className="mt-3 h-11" onClick={() => void session.signOut()}>Sign out</Button></section></main>;
}
