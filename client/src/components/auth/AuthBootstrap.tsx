import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useAuthStore } from '../../store/useAuthStore';

interface AuthBootstrapProps {
  children: ReactNode;
}

export default function AuthBootstrap({ children }: AuthBootstrapProps) {
  const fetchCurrentUser = useAuthStore((state) => state.fetchCurrentUser);
  const hasHydrated = useAuthStore((state) => state.hasHydrated);
  const logout = useAuthStore((state) => state.logout);
  const token = useAuthStore((state) => state.token);

  useEffect(() => {
    const handleUnauthorized = () => logout();
    window.addEventListener('auth:unauthorized', handleUnauthorized);

    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, [logout]);

  useEffect(() => {
    if (hasHydrated && token) {
      void fetchCurrentUser();
    }
  }, [fetchCurrentUser, hasHydrated, token]);

  return children;
}
