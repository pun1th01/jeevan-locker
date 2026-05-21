import { Loader2, LockKeyhole, Mail, Shield, Stethoscope, UserPlus, UserRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../store/useAuthStore';
import type { RegisterPayload, UserRole } from '../../types/auth';

const roleOptions: Array<{
  value: UserRole;
  label: string;
  Icon: typeof UserRound;
}> = [
  { value: 'patient', label: 'Patient', Icon: UserRound },
  { value: 'doctor', label: 'Doctor', Icon: Stethoscope },
  { value: 'admin', label: 'Admin', Icon: Shield },
];

type RegisterFormErrors = Partial<Record<keyof RegisterPayload, string>>;

export default function RegisterPage() {
  const navigate = useNavigate();
  const register = useAuthStore((state) => state.register);
  const isLoading = useAuthStore((state) => state.isLoading);
  const apiError = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);
  const [form, setForm] = useState<RegisterPayload>({
    name: '',
    email: '',
    password: '',
    role: 'patient',
  });
  const [errors, setErrors] = useState<RegisterFormErrors>({});

  const updateField = <Field extends keyof RegisterPayload>(field: Field, value: RegisterPayload[Field]) => {
    clearError();
    setErrors((currentErrors) => ({ ...currentErrors, [field]: undefined }));
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  };

  const validate = () => {
    const nextErrors: RegisterFormErrors = {};

    if (form.name.trim().length < 2) {
      nextErrors.name = 'Name must be at least 2 characters';
    }

    if (!form.email.includes('@')) {
      nextErrors.email = 'Enter a valid email address';
    }

    if (form.password.length < 8) {
      nextErrors.password = 'Password must be at least 8 characters';
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
      await register({ ...form, email: form.email.trim().toLowerCase(), name: form.name.trim() });
      navigate('/dashboard', { replace: true });
    } catch {
      // Store-level error state drives the visible message.
    }
  };

  return (
    <section className="grid min-h-[calc(100vh-80px)] items-center gap-8 py-10 lg:grid-cols-[1fr_1fr]">
      <div className="mx-auto w-full max-w-md rounded-lg border border-white/10 bg-slate-900/80 p-6 shadow-2xl shadow-cyan-950/20 backdrop-blur">
        <div>
          <h1 className="text-2xl font-bold text-white">Create account</h1>
          <p className="mt-2 text-sm text-slate-400">Choose the workspace role that matches this identity.</p>
        </div>

        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="name">Full name</Label>
            <div className="relative">
              <UserRound className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-500" />
              <Input
                id="name"
                value={form.name}
                onChange={(event) => updateField('name', event.target.value)}
                className="pl-10"
                placeholder="Aarav Sharma"
                autoComplete="name"
              />
            </div>
            {errors.name ? <p className="text-sm text-rose-300">{errors.name}</p> : null}
          </div>

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
                placeholder="Minimum 8 characters"
                autoComplete="new-password"
              />
            </div>
            {errors.password ? <p className="text-sm text-rose-300">{errors.password}</p> : null}
          </div>

          <div className="space-y-2">
            <Label>Workspace role</Label>
            <div className="grid grid-cols-3 gap-2">
              {roleOptions.map(({ value, label, Icon }) => {
                const selected = form.role === value;

                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => updateField('role', value)}
                    className={cn(
                      'flex h-20 flex-col items-center justify-center gap-2 rounded-md border text-sm font-semibold transition-colors',
                      selected
                        ? 'border-emerald-300 bg-emerald-300/10 text-emerald-100'
                        : 'border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.06] hover:text-slate-100'
                    )}
                  >
                    <Icon className="h-5 w-5" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {apiError ? (
            <div className="rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
              {apiError}
            </div>
          ) : null}

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Create account
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          Already registered?{' '}
          <Link className="font-semibold text-emerald-300 hover:text-emerald-200" to="/login">
            Sign in
          </Link>
        </p>
      </div>

      <div className="hidden lg:block">
        <p className="text-sm font-semibold text-cyan-300">Medical access control</p>
        <h2 className="mt-4 max-w-xl text-4xl font-bold leading-tight text-white">
          A dedicated workspace for patients, clinicians, and platform administrators.
        </h2>
        <div className="mt-8 grid max-w-lg grid-cols-3 gap-3">
          {roleOptions.map(({ value, label, Icon }) => (
            <div key={value} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <Icon className="h-5 w-5 text-emerald-300" />
              <p className="mt-4 text-sm font-semibold text-white">{label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
