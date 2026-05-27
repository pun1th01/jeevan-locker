import { app } from './app';
import { connectDB } from './config/db';
import { env } from './config/env';
import { seedDemoUsers } from './utils/seedDemoUsers';

const startServer = async () => {
  await connectDB();
  
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
