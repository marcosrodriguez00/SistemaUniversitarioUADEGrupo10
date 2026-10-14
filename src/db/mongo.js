import 'dotenv/config';
import { MongoClient } from 'mongodb';

let client;

export async function connect() {
  if (!client) {
    client = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
  }
  return client.db(process.env.MONGO_DB);
}

export async function close() {
  if (client) { await client.close(); client = null; }
}