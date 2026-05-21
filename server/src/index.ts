import { app } from './app';
import { connectDB } from './config/db';
import { env } from './config/env';

const startServer = async () => {
  await connectDB();

  app.listen(env.port, () => {
    console.log(`JeevanLocker API running on port ${env.port}`);
  });
};

startServer().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error(`Server startup failed: ${message}`);
  process.exit(1);
});
