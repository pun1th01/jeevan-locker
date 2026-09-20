/**
 * Provisions an admin account from the CLI. Admins cannot self-register (see REGISTRABLE_ROLES).
 *
 *   npm run create:admin -- --name "Jane Admin" --email jane@example.com --password 'Str0ngPass!'
 *
 * Connects straight to MONGO_URI: the in-memory dev database used by `npm run dev` is bypassed on
 * purpose, otherwise the admin would vanish when that process exits.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { User } from '../models/User';
import { createAuditLog } from '../utils/audit.util';
import { validateRegisterInput } from '../utils/validation.util';

/** Audit rows written from the CLI have no request context; this marker replaces the IP. */
const CLI_IP_ADDRESS = 'cli';

interface CliArgs {
  name?: string;
  email?: string;
  password?: string;
}

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === '--name' || flag === '--email' || flag === '--password') {
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

const describeDatabase = (): string => {
  const { host, port, name } = mongoose.connection;
  return `${host}:${port}/${name}`;
};

const createAdmin = async () => {
  const args = parseArgs(process.argv.slice(2));

  // Reuse the registration validator for name/email/password rules, then override the role:
  // the validator deliberately refuses 'admin', which is exactly the gate this script bypasses.
  const validation = validateRegisterInput({ name: args.name, email: args.email, password: args.password, role: 'patient' });

  if (!validation.data) {
    const details = Object.entries(validation.errors)
      .map(([field, message]) => `  --${field}: ${message}`)
      .join('\n');
    throw new Error(`Invalid arguments:\n${details}`);
  }

  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  console.log(`Connected to ${describeDatabase()} (direct MONGO_URI, not the in-memory dev database)`);

  const existingUser = await User.findOne({ email: validation.data.email }).select('role');

  if (existingUser) {
    throw new Error(`A user with email ${validation.data.email} already exists (role: ${existingUser.role})`);
  }

  const admin = await User.create({
    name: validation.data.name,
    email: validation.data.email,
    password: validation.data.password,
    role: 'admin',
  });

  await createAuditLog({
    userId: admin._id,
    action: 'ADMIN_CREATED',
    ipAddress: CLI_IP_ADDRESS,
    metadata: { createdBy: 'cli', email: admin.email },
  });

  console.log(`Admin created: ${admin.name} <${admin.email}> (id ${admin._id.toString()})`);
};

createAdmin()
  .then(() => mongoose.disconnect())
  .then(() => {
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`create:admin failed: ${message}`);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
