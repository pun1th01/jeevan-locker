import { REGISTRABLE_ROLES, USER_ROLES, type RegistrableRole, type UserRole } from '../types/user.types';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ORGANISATION_MIN_LENGTH = 2;
export const ORGANISATION_MAX_LENGTH = 120;

interface ValidationResult<T> {
  data?: T;
  errors: Record<string, string>;
}

interface AccountFields {
  name: string;
  email: string;
  password: string;
}

interface RegisterInput extends AccountFields {
  role: RegistrableRole;
  organisation?: string;
}

interface LabUserInput extends AccountFields {
  organisation: string;
}

interface LoginInput {
  email: string;
  password: string;
}

export const isUserRole = (value: unknown): value is UserRole =>
  typeof value === 'string' && USER_ROLES.includes(value as UserRole);

/** True only for roles a user may self-select at registration; admin and lab are never registrable. */
export const isRegistrableRole = (value: unknown): value is RegistrableRole =>
  typeof value === 'string' && REGISTRABLE_ROLES.includes(value as RegistrableRole);

/** Name / email / password rules shared by self-registration, admin lab provisioning, and the CLI. */
const validateAccountFields = (body: Record<string, unknown>): ValidationResult<AccountFields> => {
  const errors: Record<string, string> = {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (name.length < 2) {
    errors.name = 'Name must be at least 2 characters';
  }

  if (!emailPattern.test(email)) {
    errors.email = 'Enter a valid email address';
  }

  if (password.length < 8) {
    errors.password = 'Password must be at least 8 characters';
  }

  return Object.keys(errors).length > 0 ? { errors } : { data: { name, email, password }, errors };
};

/** Returns the trimmed organisation, `undefined` when absent/blank, or an error message when present but invalid. */
const validateOrganisation = (value: unknown): { organisation?: string; error?: string } => {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'string') {
    return { error: 'Organisation must be text' };
  }

  const organisation = value.trim();

  if (!organisation) {
    return {};
  }

  if (organisation.length < ORGANISATION_MIN_LENGTH || organisation.length > ORGANISATION_MAX_LENGTH) {
    return { error: `Organisation must be ${ORGANISATION_MIN_LENGTH} to ${ORGANISATION_MAX_LENGTH} characters` };
  }

  return { organisation };
};

/**
 * POST /auth/register. `organisation` is accepted for doctors only; for patients it is silently dropped
 * so a stray field cannot attach an affiliation to a patient account.
 */
export const validateRegisterInput = (body: Record<string, unknown>): ValidationResult<RegisterInput> => {
  const account = validateAccountFields(body);
  const errors = { ...account.errors };
  const requestedRole: unknown = body.role ?? 'patient';
  const organisation = validateOrganisation(body.organisation);

  if (!isRegistrableRole(requestedRole)) {
    errors.role = 'Role must be patient or doctor';
  }

  if (organisation.error) {
    errors.organisation = organisation.error;
  }

  if (!account.data || !isRegistrableRole(requestedRole) || Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    data: {
      ...account.data,
      role: requestedRole,
      ...(requestedRole === 'doctor' && organisation.organisation ? { organisation: organisation.organisation } : {}),
    },
    errors,
  };
};

/** POST /api/admin/users and `create:lab`: same account rules, organisation mandatory. */
export const validateLabUserInput = (body: Record<string, unknown>): ValidationResult<LabUserInput> => {
  const account = validateAccountFields(body);
  const errors = { ...account.errors };
  const organisation = validateOrganisation(body.organisation);

  if (organisation.error) {
    errors.organisation = organisation.error;
  } else if (!organisation.organisation) {
    errors.organisation = 'Organisation is required for lab accounts';
  }

  if (!account.data || !organisation.organisation || Object.keys(errors).length > 0) {
    return { errors };
  }

  return { data: { ...account.data, organisation: organisation.organisation }, errors };
};

/** `create:admin`: account rules only; role and verification are fixed by the caller. */
export const validateAdminUserInput = (body: Record<string, unknown>): ValidationResult<AccountFields> =>
  validateAccountFields(body);

export const validateLoginInput = (body: Record<string, unknown>): ValidationResult<LoginInput> => {
  const errors: Record<string, string> = {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!emailPattern.test(email)) {
    errors.email = 'Enter a valid email address';
  }

  if (!password) {
    errors.password = 'Password is required';
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    data: {
      email,
      password,
    },
    errors,
  };
};
