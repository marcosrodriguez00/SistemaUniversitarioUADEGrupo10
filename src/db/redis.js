import 'dotenv/config';
import Redis from 'ioredis';

let redis;

export async function connect() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // falla rápido si el motor está caído
    });
  }
  if (redis.status === 'wait') await redis.connect();
  return redis;
}

export async function close() {
  if (redis) { redis.disconnect(); redis = null; }
}