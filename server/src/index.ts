import { app } from './app';
import { connectDB } from './config/db';
import { env } from './config/env';
import { registerAppEventListeners } from './events/registerListeners';
import { verifyChainContractsAtBoot } from './services/chain.service';
import { seedDemoUsers } from './utils/seedDemoUsers';

const startServer = async () => {
  await connectDB();
  // Refuses to start if a configured contract address holds no code; warns (and continues) when the
  // chain is unconfigured or unreachable. See chain.service.ts.
  await verifyChainContractsAtBoot();
  registerAppEventListeners();
  
  if (env.nodeEnv === 'development') {
    await seedDemoUsers();
  }

  app.listen(env.port, () => {
    console.log(`JeevanLocker API running on port ${env.port}`);
  });
};

startServer().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error(`Server startup failed: ${message}`);
  process.exit(1);
});
