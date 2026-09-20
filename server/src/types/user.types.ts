export const USER_ROLES = ['patient', 'doctor', 'admin', 'lab'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Roles a user may pick for themselves at POST /auth/register.
 * Admins are provisioned only via `npm run create:admin` (CLI, permanently).
 * Labs are provisioned by an admin via POST /api/admin/users or `npm run create:lab`.
 */
export const REGISTRABLE_ROLES = ['patient', 'doctor'] as const satisfies readonly UserRole[];

/** Roles an admin may provision through POST /api/admin/users. Admin is deliberately absent. */
export const ADMIN_PROVISIONABLE_ROLES = ['lab'] as const satisfies readonly UserRole[];

export type RegistrableRole = (typeof REGISTRABLE_ROLES)[number];

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** Admin-verified. Gates doctor-initiated access (lookup, consent, break-glass). Always true for provisioned accounts. */
  verified: boolean;
  /** Hospital / organisation affiliation. Optional for doctors, required for labs, absent for patients and admins. */
  organisation?: string;
  createdAt: string;
}
