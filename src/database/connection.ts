import mongoose from "mongoose";

let connected = false;
let attempted = false;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.MONGODB_URI);
}

export function isDatabaseConnected(): boolean {
  return connected;
}

export async function connectDatabase(): Promise<boolean> {
  if (connected) {
    return true;
  }
  if (attempted && mongoose.connection.readyState === 1) {
    connected = true;
    return true;
  }

  const uri = process.env.DATABASE_URL || process.env.MONGODB_URI;
  if (!uri) {
    return false;
  }

  attempted = true;
  await mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  connected = true;
  return true;
}

