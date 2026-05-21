import { LockKeyhole, LogIn, Mail, Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/useAuthStore';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';

interface LoginForm {
  email: string;
  password: string;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((state) => state.login);
  const isLoading = useAuthStore((state) => state.isLoading);
  const apiError = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);
  const [form, setForm] = useState<LoginForm>({ email: '', password: '' });
  const [errors, setErrors] = useState<Partial<LoginForm>>({});

  const updateField = (field: keyof LoginForm, value: string) => {
    clearError();
    setErrors((currentErrors) => ({ ...currentErrors, [field]: undefined }));
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  };

  const validate = () => {
    const nextErrors: Partial<LoginForm> = {};

    if (!form.email.includes('@')) {
      nextErrors.email = 'Enter a valid email address';
    }

    if (!form.password) {
      nextErrors.password = 'Password is required';
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!validate()) {
      return;
    }

    try {
      await login(form);
      const redirectTo =
        (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/dashboard';
      navigate(redirectTo, { replace: true });
    } catch {
      // Store-level error state drives the visible message.
    }
  };

  return (
    <section className="grid min-h-[calc(100vh-80px)] items-center gap-8 py-10 lg:grid-cols-[0.9fr_1.1fr]">
      <div className="hidden lg:block">
        <p className="text-sm font-semibold text-emerald-300">Secure clinical identity</p>
        <h1 className="mt-4 max-w-xl text-4xl font-bold leading-tight text-white">
          Access medical records through verified role-based sessions.
        </h1>
        <div className="mt-8 grid max-w-lg gap-3 text-sm text-slate-400">
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
            JWT-backed session persistence with server validation.
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
            Role checks keep patient, doctor, and admin workspaces isolated.
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-md rounded-lg border border-white/10 bg-slate-900/80 p-6 shadow-2xl shadow-emerald-950/20 backdrop-blur">
        <div>
          <h2 className="text-2xl font-bold text-white">Welcome back</h2>
          <p className="mt-2 text-sm text-slate-400">Sign in to continue to your JeevanLocker workspace.</p>
        </div>

        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-500" />
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(event) => updateField('email', event.target.value)}
                className="pl-10"
                placeholder="name@example.com"
                autoComplete="email"
              />
            </div>
            {errors.email ? <p className="text-sm text-rose-300">{errors.email}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-500" />
              <Input
                id="password"
                type="password"
                value={form.password}
                onChange={(event) => updateField('password', event.target.value)}
                className="pl-10"
                placeholder="Enter password"
                autoComplete="current-password"
              />
            </div>
            {errors.password ? <p className="text-sm text-rose-300">{errors.password}</p> : null}
          </div>

          {apiError ? (
            <div className="rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
              {apiError}
            </div>
          ) : null}

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            Sign in
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          New to JeevanLocker?{' '}
          <Link className="font-semibold text-emerald-300 hover:text-emerald-200" to="/register">
            Create an account
          </Link>
        </p>
      </div>
    </section>
  );
}
