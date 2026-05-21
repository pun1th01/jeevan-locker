import { api } from '../lib/api';
import type { AuthResponse, LoginCredentials, RegisterPayload, User } from '../types/auth';

interface CurrentUserResponse {
  user: User;
}

export const authService = {
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    const { data } = await api.post<AuthResponse>('/auth/login', credentials);
    return data;
  },

  async register(payload: RegisterPayload): Promise<AuthResponse> {
    const { data } = await api.post<AuthResponse>('/auth/register', payload);
    return data;
  },

  async getCurrentUser(): Promise<User> {
    const { data } = await api.get<CurrentUserResponse>('/auth/me');
    return data.user;
  },
};
