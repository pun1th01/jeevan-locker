import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AUTH_STORAGE_KEY, getApiErrorMessage } from '../lib/api';
import { authService } from '../services/auth.service';
import type { LoginCredentials, RegisterPayload, User } from '../types/auth';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  hasHydrated: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => void;
  fetchCurrentUser: () => Promise<void>;
  clearError: () => void;
  setHasHydrated: (hasHydrated: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isLoading: false,
      error: null,
      hasHydrated: false,

      async login(credentials) {
        set({ isLoading: true, error: null });

        try {
          const { user, token } = await authService.login(credentials);
          set({ user, token, isLoading: false, error: null });
        } catch (error) {
          set({ isLoading: false, error: getApiErrorMessage(error) });
          throw error;
        }
      },

      async register(payload) {
        set({ isLoading: true, error: null });

        try {
          const { user, token } = await authService.register(payload);
          set({ user, token, isLoading: false, error: null });
        } catch (error) {
          set({ isLoading: false, error: getApiErrorMessage(error) });
          throw error;
        }
      },

      logout() {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        set({ user: null, token: null, error: null, isLoading: false });
      },

      async fetchCurrentUser() {
        if (!get().token) {
          return;
        }

        set({ isLoading: true, error: null });

        try {
          const user = await authService.getCurrentUser();
          set({ user, isLoading: false, error: null });
        } catch (error) {
          get().logout();
          set({ error: getApiErrorMessage(error) });
        }
      },

      clearError() {
        set({ error: null });
      },

      setHasHydrated(hasHydrated) {
        set({ hasHydrated });
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      partialize: (state) => ({
        user: state.user,
        token: state.token,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
