import bcrypt from 'bcrypt';
import { User } from '../models/User';
import { env } from '../config/env';

export const seedDemoUsers = async (): Promise<void> => {
  if (env.nodeEnv !== 'development') {
    return;
  }

  const demoAccounts = [
    {
      name: 'Demo Admin',
      email: 'admin@jeevanlocker.dev',
      passwordPlain: 'Admin123!',
      role: 'admin' as const,
    },
    {
      name: 'Demo Doctor',
      email: 'doctor@jeevanlocker.dev',
      passwordPlain: 'Doctor123!',
      role: 'doctor' as const,
    },
    {
      name: 'Demo Patient',
      email: 'patient@jeevanlocker.dev',
      passwordPlain: 'Patient123!',
      role: 'patient' as const,
    },
  ];

  for (const account of demoAccounts) {
    const exists = await User.exists({ email: account.email });
    if (!exists) {
      await User.create({
        name: account.name,
        email: account.email,
        password: account.passwordPlain, // The pre-save hook handles hashing
        role: account.role,
      });
      console.log(`[Dev] Seeded demo account: ${account.email}`);
    }
  }
};
