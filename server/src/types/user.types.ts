export const USER_ROLES = ['patient', 'doctor', 'admin'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Roles a user may pick for themselves at POST /auth/register.
 * Admins are provisioned only via `npm run create:admin` (server/src/scripts/createAdmin.ts).
 */
export const REGISTRABLE_ROLES = ['patient', 'doctor'] as const satisfies readonly UserRole[];

export type RegistrableRole = (typeof REGISTRABLE_ROLES)[number];

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: string;
}
