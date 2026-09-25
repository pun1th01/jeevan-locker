import { api } from '../lib/api';
import type { User } from '../types/auth';

export interface CreateLabUserInput {
  name: string;
  email: string;
  password: string;
  organisation: string;
  role: 'lab';
}

interface AdminUsersResponse {
  users: User[];
}

interface VerifyDoctorResponse {
  message: string;
  user: User;
}

interface CreateLabUserResponse {
  user: User;
}

export const adminService = {
  async getPendingDoctors(): Promise<User[]> {
    const { data } = await api.get<AdminUsersResponse>('/admin/users', {
      params: { role: 'doctor', verified: false },
    });
    return data.users;
  },

  async verifyDoctor(doctorId: string): Promise<VerifyDoctorResponse> {
    const { data } = await api.patch<VerifyDoctorResponse>(`/admin/users/${doctorId}/verify`);
    return data;
  },

  async createLab(input: CreateLabUserInput): Promise<User> {
    const { data } = await api.post<CreateLabUserResponse>('/admin/users', input);
    return data.user;
  },
};
