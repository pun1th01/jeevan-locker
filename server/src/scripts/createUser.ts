/**
 * Provisions an admin or lab account from the CLI. Neither role can self-register (see REGISTRABLE_ROLES).
 * Admin creation is CLI-only, permanently — there is no HTTP endpoint for it by design.
 *
 *   npm run create:admin -- --name "Jane Admin" --email jane@example.com --password 'Str0ngPass!'
 *   npm run create:lab   -- --name "City Diagnostics" --email lab@example.com --password 'Str0ngPass!' --organisation "City Diagnostics Pvt Ltd"
 *
 * Connects straight to MONGO_URI: the in-memory dev database used by `npm run dev` is bypassed on
 * purpose, otherwise the account would vanish when that process exits.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import type { AuditAction } from '../models/AccessLog';
import { User } from '../models/User';
import { createAuditLog } from '../utils/audit.util';
import { validateAdminUserInput, validateLabUserInput } from '../utils/validation.util';

/** Audit rows written from the CLI have no request context; this marker replaces the IP. */
const CLI_IP_ADDRESS = 'cli';

const PROVISIONABLE_ROLES = ['admin', 'lab'] as const;
type ProvisionableRole = (typeof PROVISIONABLE_ROLES)[number];

const AUDIT_ACTION_BY_ROLE: Record<ProvisionableRole, AuditAction> = {
  admin: 'ADMIN_CREATED',
  lab: 'LAB_CREATED',
};

interface CliArgs {
  role?: string;
  name?: string;
  email?: string;
  password?: string;
  organisation?: string;
}

const FLAGS = ['--role', '--name', '--email', '--password', '--organisation'] as const;

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if ((FLAGS as readonly string[]).includes(flag)) {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${flag}`);
      }

      args[flag.slice(2) as keyof CliArgs] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${flag}`);
  }

  return args;
};

const isProvisionableRole = (value: unknown): value is ProvisionableRole =>
  typeof value === 'string' && (PROVISIONABLE_ROLES as readonly string[]).includes(value);

const formatErrors = (errors: Record<string, string>) =>
  Object.entries(errors)
    .map(([field, message]) => `  --${field}: ${message}`)
    .join('\n');

const describeDatabase = (): string => {
  const { host, port, name } = mongoose.connection;
  return `${host}:${port}/${name}`;
};

const createUser = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!isProvisionableRole(args.role)) {
    throw new Error('--role must be admin or lab');
  }

  const role = args.role;
  const validation =
    role === 'lab'
      ? validateLabUserInput({ name: args.name, email: args.email, password: args.password, organisation: args.organisation })
      : validateAdminUserInput({ name: args.name, email: args.email, password: args.password });

  if (!validation.data) {
    throw new Error(`Invalid arguments:\n${formatErrors(validation.errors)}`);
  }

  if (role === 'admin' && args.organisation !== undefined) {
    throw new Error('--organisation applies to lab accounts only');
  }

  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  console.log(`Connected to ${describeDatabase()} (direct MONGO_URI, not the in-memory dev database)`);

  const existingUser = await User.findOne({ email: validation.data.email }).select('role');

  if (existingUser) {
    throw new Error(`A user with email ${validation.data.email} already exists (role: ${existingUser.role})`);
  }

  const user = await User.create({
    ...validation.data,
    role,
    // Provisioned accounts are verified by definition: an operator vouched for them.
    verified: true,
  });

  await createAuditLog({
    userId: user._id,
    action: AUDIT_ACTION_BY_ROLE[role],
    ipAddress: CLI_IP_ADDRESS,
    metadata: {
      createdBy: 'cli',
      email: user.email,
      ...(user.organisation ? { organisation: user.organisation } : {}),
    },
  });

  console.log(`${role === 'admin' ? 'Admin' : 'Lab'} created: ${user.name} <${user.email}> (id ${user._id.toString()})`);
};

createUser()
  .then(() => mongoose.disconnect())
  .then(() => {
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`create:user failed: ${message}`);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
