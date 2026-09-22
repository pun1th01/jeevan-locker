import { app } from './app';
import { connectDB } from './config/db';
import { env } from './config/env';
import { registerAppEventListeners } from './events/registerListeners';
import { reconcileMissingAnchors } from './services/anchorQueue.service';
import { startAnchorWorker, stopAnchorWorker } from './services/anchorWorker.service';
import { readExpiryWorkerConfig, startExpiryWorker, stopExpiryWorker } from './services/expiryWorker.service';
import { verifyChainContractsAtBoot } from './services/chain.service';
import { emergencyAccessConfigSummary } from './utils/emergencyAccess.util';
import { seedDemoUsers } from './utils/seedDemoUsers';

const startServer = async () => {
  await connectDB();
  // Refuses to start if a configured contract address holds no code; warns (and continues) when the
  // chain is unconfigured or unreachable. See chain.service.ts.
  await verifyChainContractsAtBoot();
  registerAppEventListeners();
  // Re-derive any anchor rows lost between an audit write and its enqueue, then start draining.
  await reconcileMissingAnchors();
  startAnchorWorker();
  // Ends lapsed break-glass grants on time, whether or not the doctor holding one comes back.
  startExpiryWorker();
  // Effective break-glass settings, so a value that was misspelt in .env is visible here and not mid-demo.
  console.log(`[emergency] ${emergencyAccessConfigSummary()}, expiry sweep every ${readExpiryWorkerConfig().pollMs}ms`);
  
  if (env.nodeEnv === 'development') {
    await seedDemoUsers();
  }

  app.listen(env.port, () => {
    console.log(`JeevanLocker API running on port ${env.port}`);
  });
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopAnchorWorker();
    stopExpiryWorker();
    process.exit(0);
  });
}

startServer().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error(`Server startup failed: ${message}`);
  process.exit(1);
});
