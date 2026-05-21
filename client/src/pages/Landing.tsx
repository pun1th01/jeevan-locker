import { ArrowRight, LogIn, UserPlus } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import heroImage from '../assets/hero.png';
import { Button } from '../components/ui/button';
import { useAuthStore } from '../store/useAuthStore';

export default function Landing() {
  const user = useAuthStore((state) => state.user);

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <section className="py-6">
      <div
        className="relative flex min-h-[calc(100vh-132px)] overflow-hidden bg-slate-900"
        style={{
          backgroundImage: `linear-gradient(90deg, rgba(2, 6, 23, 0.96) 0%, rgba(2, 6, 23, 0.82) 42%, rgba(2, 6, 23, 0.3) 100%), url(${heroImage})`,
          backgroundPosition: 'center',
          backgroundSize: 'cover',
        }}
      >
        <div className="flex w-full items-center px-6 py-12 md:px-12">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-emerald-300">Medical identity and access</p>
            <h1 className="mt-4 text-4xl font-bold leading-tight text-white md:text-6xl">JeevanLocker</h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-300 md:text-lg">
              A secure foundation for patient, doctor, and admin access to medical record workflows.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild>
                <Link to="/register">
                  <UserPlus className="h-4 w-4" />
                  Create account
                </Link>
              </Button>
              <Button asChild variant="secondary">
                <Link to="/login">
                  <LogIn className="h-4 w-4" />
                  Sign in
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 py-6 md:grid-cols-3">
        {['Protected sessions', 'Role-based dashboards', 'Persistent access'].map((item) => (
          <div key={item} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <span className="text-sm font-semibold text-slate-200">{item}</span>
            <ArrowRight className="h-4 w-4 text-emerald-300" />
          </div>
        ))}
      </div>
    </section>
  );
}
