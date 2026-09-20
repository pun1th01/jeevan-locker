import { REGISTRABLE_ROLES, USER_ROLES, type RegistrableRole, type UserRole } from '../types/user.types';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ValidationResult<T> {
  data?: T;
  errors: Record<string, string>;
}

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  role: RegistrableRole;
}

interface LoginInput {
  email: string;
  password: string;
}

export const isUserRole = (value: unknown): value is UserRole =>
  typeof value === 'string' && USER_ROLES.includes(value as UserRole);

/** True only for roles a user may self-select at registration; admin is never registrable. */
export const isRegistrableRole = (value: unknown): value is RegistrableRole =>
  typeof value === 'string' && REGISTRABLE_ROLES.includes(value as RegistrableRole);

export const validateRegisterInput = (body: Record<string, unknown>): ValidationResult<RegisterInput> => {
  const errors: Record<string, string> = {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const requestedRole: unknown = body.role ?? 'patient';

  if (name.length < 2) {
    errors.name = 'Name must be at least 2 characters';
  }

  if (!emailPattern.test(email)) {
    errors.email = 'Enter a valid email address';
  }

  if (password.length < 8) {
    errors.password = 'Password must be at least 8 characters';
  }

  if (!isRegistrableRole(requestedRole)) {
    errors.role = 'Role must be patient or doctor';
  }

  if (Object.keys(errors).length > 0 || !isRegistrableRole(requestedRole)) {
    return { errors };
  }

  return {
    data: {
      name,
      email,
      password,
      role: requestedRole,
    },
    errors,
  };
};

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
