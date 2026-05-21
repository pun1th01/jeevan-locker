import mongoose from 'mongoose';
import { env } from './env';

export const connectDB = async () => {
  const connection = await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log(`MongoDB connected: ${connection.connection.host}`);
};
