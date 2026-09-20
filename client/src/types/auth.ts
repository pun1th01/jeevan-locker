export type UserRole = 'patient' | 'doctor' | 'admin';

/** Roles a user can pick on the register page. Admins are provisioned server-side only. */
export type RegistrableRole = Exclude<UserRole, 'admin'>;

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** Admin-verified. Unverified doctors cannot look up patients, request consent, or break-glass. */
  verified: boolean;
  createdAt: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterPayload extends LoginCredentials {
  name: string;
  role: RegistrableRole;
}
