import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, AppWindow, Bell, Building2, Coins, LayoutDashboard, LogOut, Menu, Settings, Sparkles, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { consoleApi } from '@/lib/api';

const NAV: { to: string; icon: LucideIcon; label: string }[] = [
  { to: '/', icon: LayoutDashboard, label: 'Visão geral' },
  { to: '/empresas', icon: Building2, label: 'Empresas e números' },
  { to: '/aplicacoes', icon: AppWindow, label: 'Aplicações' },
  { to: '/ia', icon: Sparkles, label: 'Provedores de IA' },
  { to: '/creditos', icon: Coins, label: 'Créditos e pacotes' },
  { to: '/alertas', icon: Bell, label: 'Alertas' },
  { to: '/configuracoes', icon: Settings, label: 'Configurações' },
];

/** Menu lateral navy no mesmo padrão dos produtos (Clinova, Agenda+). */
export default function Layout() {
  const [open, setOpen] = useState(false);
  const { me, signOut } = useAuth();
  const location = useLocation();
  const { data } = useQuery({
    queryKey: ['alerts-count'],
    queryFn: () => consoleApi<{ overview: { alerts_open: number; alerts_critical: number } }>('overview'),
    refetchInterval: 60_000,
  });
  const openAlerts = data?.overview?.alerts_open ?? 0;

  const nav = (
    <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
      {NAV.map(({ to, icon: Icon, label }) => {
        const active = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
        return (
          <NavLink key={to} to={to} onClick={() => setOpen(false)}
            className={cn(
              'group relative flex items-center gap-3 px-3 py-2 mx-1 rounded-btn text-[13px] font-medium transition-all duration-150 ease-stripe',
              active ? 'bg-[hsl(var(--primary)/0.22)] text-white' : 'text-white/70 hover:bg-white/5 hover:text-white',
            )}>
            {active && <span aria-hidden="true" className="absolute right-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-primary" />}
            <Icon className="w-4 h-4 shrink-0" />
            <span className="truncate">{label}</span>
            {to === '/alertas' && openAlerts > 0 && (
              <span className="ml-auto rounded-pill bg-[hsl(var(--destructive))] px-1.5 text-[10px] font-semibold text-white">{openAlerts}</span>
            )}
          </NavLink>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="lg:hidden fixed top-0 left-0 right-0 z-50 bg-sidebar border-b border-[hsl(var(--sidebar-border))] px-4 h-[60px] flex items-center justify-between">
        <Brand />
        <button onClick={() => setOpen(!open)} className="p-2 rounded-btn text-white/90 hover:bg-white/10" aria-label={open ? 'Fechar menu' : 'Abrir menu'}>
          {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>
      {open && <div className="lg:hidden fixed inset-0 z-40 bg-[hsl(var(--bg-navy)/0.52)]" onClick={() => setOpen(false)} />}

      <aside className={cn(
        'fixed top-0 left-0 z-40 h-full w-[220px] flex flex-col transition-transform duration-300 ease-stripe bg-sidebar text-sidebar-foreground border-r border-[hsl(var(--sidebar-border))] lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="px-5 h-[60px] flex items-center border-b border-[hsl(var(--sidebar-border))] shrink-0"><Brand /></div>
        {nav}
        <div className="p-2 border-t border-[hsl(var(--sidebar-border))] shrink-0">
          <div className="px-3 py-2 text-[11px] text-white/50 truncate" title={me?.email}>{me?.email}</div>
          <button onClick={signOut}
            className="flex items-center gap-3 px-3 py-2 mx-1 rounded-btn text-[13px] font-medium text-white/70 hover:bg-[hsl(var(--destructive)/0.18)] hover:text-white transition-all w-[calc(100%-0.5rem)]">
            <LogOut className="w-4 h-4" /> Sair
          </button>
        </div>
      </aside>

      <main className="lg:pl-[220px] pt-[60px] lg:pt-0">
        <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div className="w-9 h-9 rounded-btn bg-primary flex items-center justify-center shrink-0 shadow-glow">
        <Activity className="w-4 h-4 text-primary-foreground" />
      </div>
      <div className="min-w-0">
        <h1 className="font-heading font-semibold text-white text-[15px] leading-tight tracking-tight truncate">Aura IA</h1>
        <p className="text-[11px] uppercase tracking-wider text-white/50 font-medium mt-0.5">Console</p>
      </div>
    </div>
  );
}
