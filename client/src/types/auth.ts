export type UserRole = 'patient' | 'doctor' | 'admin' | 'lab';

/** Roles a user can pick on the register page. Admins (CLI) and labs (admin endpoint) are provisioned server-side only. */
export type RegistrableRole = Exclude<UserRole, 'admin' | 'lab'>;

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** Admin-verified. Unverified doctors cannot look up patients, request consent, or break-glass. */
  verified: boolean;
  /** Hospital / organisation affiliation. Optional for doctors, required for labs, absent otherwise. */
  organisation?: string;
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
