import { LogIn, LayoutDashboard, ShieldCheck, UserPlus } from 'lucide-react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuthStore } from '../../store/useAuthStore';
import { Button } from '../ui/button';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm font-medium transition-colors ${
    isActive ? 'text-emerald-300' : 'text-slate-400 hover:text-white'
  }`;

export default function Layout() {
  const user = useAuthStore((state) => state.user);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="fixed inset-0 -z-10 bg-[linear-gradient(180deg,#020617_0%,#06111f_45%,#0b1220_100%)]" />
      <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex h-20 w-full max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-3 text-lg font-bold text-white">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-300 text-slate-950">
              <ShieldCheck className="h-5 w-5" />
            </span>
            JeevanLocker
          </Link>

          <div className="flex items-center gap-3">
            {user ? (
              <NavLink className={navLinkClass} to="/dashboard">
                Dashboard
              </NavLink>
            ) : null}

            {user ? (
              <Button asChild size="sm" variant="secondary">
                <Link to="/dashboard">
                  <LayoutDashboard className="h-4 w-4" />
                  Open
                </Link>
              </Button>
            ) : (
              <>
                <Button asChild size="sm" variant="ghost">
                  <Link to="/login">
                    <LogIn className="h-4 w-4" />
                    Sign in
                  </Link>
                </Button>
                <Button asChild size="sm">
                  <Link to="/register">
                    <UserPlus className="h-4 w-4" />
                    Register
                  </Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
