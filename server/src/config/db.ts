import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { env } from './env';

let memoryServer: MongoMemoryServer | null = null;

export const connectDB = async () => {
  let uri = env.mongoUri;

  if (env.nodeEnv === 'development' && uri.includes('127.0.0.1')) {
    try {
      console.log('Attempting to use In-Memory MongoDB for Development...');
      // Imported here, not at the top: mongodb-memory-server is a devDependency, and a production install
      // (npm ci --omit=dev) must be able to load this module without it.
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      memoryServer = await MongoMemoryServer.create();
      uri = memoryServer.getUri();
    } catch (e) {
      console.log('Failed to start in-memory server, falling back to connection string.');
    }
  }

  const connection = await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
  });
  console.log(`MongoDB connected: ${connection.connection.host} (Using ${env.nodeEnv === 'development' && uri !== env.mongoUri ? 'In-Memory DB' : 'External DB'})`);
};

export const disconnectDB = async () => {
  await mongoose.disconnect();

  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
};
