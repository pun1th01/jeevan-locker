import { Activity, LogOut, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { Button } from '../ui/button';

interface DashboardMetric {
  label: string;
  value: string;
  tone: string;
}

interface DashboardShellProps {
  title: string;
  subtitle: string;
  metrics: DashboardMetric[];
  children: ReactNode;
}

export default function DashboardShell({ title, subtitle, metrics, children }: DashboardShellProps) {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  return (
    <section className="py-8">
      <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-semibold uppercase text-emerald-200">
            <ShieldCheck className="h-4 w-4" />
            {user?.role} workspace
          </div>
          <h1 className="text-3xl font-bold text-white md:text-4xl">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400 md:text-base">{subtitle}</p>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-white">{user?.name}</p>
            <p className="text-xs text-slate-400">{user?.email}</p>
          </div>
          <Button type="button" variant="secondary" size="icon" onClick={logout} aria-label="Logout">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-lg border border-white/10 bg-slate-900/70 p-5">
            <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-md bg-white/5">
              <Activity className={`h-4 w-4 ${metric.tone}`} />
            </div>
            <p className="text-2xl font-bold text-white">{metric.value}</p>
            <p className="mt-1 text-sm text-slate-400">{metric.label}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_0.8fr]">{children}</div>
    </section>
  );
}
