import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cassandra from '../db/cassandra.js';
import * as mongo from '../db/mongo.js';
import * as redis from '../db/redis.js';
import * as neo4j from '../db/neo4j.js';
import { initMongo } from './init-mongo.js';
import { initNeo4j } from './init-neo4j.js';

// Crea el keyspace y las tablas de Cassandra leyendo schema.cql.
export async function initCassandra() {
  const client = await cassandra.connect();
  const ruta = fileURLToPath(new URL('./schema.cql', import.meta.url));
  const sentencias = fs.readFileSync(ruta, 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n') // saca los comentarios
    .split(';').map((s) => s.trim()).filter(Boolean);                 // una sentencia por ';'
  for (const s of sentencias) await client.execute(s);
  console.log(`✔ Cassandra: ${sentencias.length} sentencias aplicadas`);
}

// IDEMPOTENTE: todo usa IF NOT EXISTS, se puede correr todas las veces que haga falta.
export async function initTodo() {
  await initCassandra();
  await initMongo();
  await initNeo4j();
  console.log('✔ Redis: nada que inicializar (los cupos los carga el seed o se reconstruyen solos)');
}

// Si el archivo se ejecuta directamente (npm run init), corre la inicialización.
// Si lo importa otro archivo (el seed), no hace nada hasta que lo llamen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await initTodo();
    console.log('\nInit completo.');
  } catch (e) {
    console.error('✘ Init falló:', e.message);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([cassandra.close(), mongo.close(), redis.close(), neo4j.close()]);
  }
}