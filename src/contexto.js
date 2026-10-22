import * as mongo from './db/mongo.js';
import * as redis from './db/redis.js';
import * as neo4j from './db/neo4j.js';
import * as cassandra from './db/cassandra.js';
import { crearMongoRepo, crearLogMongo } from './repos/mongo.repo.js';
import { crearNeo4jRepo } from './repos/neo4j.repo.js';
import { crearRedisRepo } from './repos/redis.repo.js';
import { crearCassandraRepo } from './repos/cassandra.repo.js';
import { conFailpoints } from './saga/failpoints.js';

// Conecta los 4 motores EN PARALELO y arma `ctx`, el objeto que reciben todos los problemas:
//   ctx.mongo   catálogo      ctx.log    saga_log (usado por el runner)
//   ctx.redis   cupos         ctx.neo4j  correlatividades
//   ctx.cass    inscripciones y notas
// failAt viene de --fail-at (CLI) o de la variable FAIL_AT: activa la falla simulada de la demo.
export async function crearContexto({ failAt = process.env.FAIL_AT || null } = {}) {
  const [db, r, driver, client] = await Promise.all([mongo.connect(), redis.connect(), neo4j.connect(), cassandra.connect()]);
  const ctx = {
    mongo: crearMongoRepo(db),
    log: crearLogMongo(db),
    redis: crearRedisRepo(r),
    neo4j: crearNeo4jRepo(driver),
    cass: crearCassandraRepo(client),
    raw: { db, redis: r, neo4j: driver, cassandra: client }, // conexiones crudas (init, seed, estado)
  };
  return conFailpoints(ctx, failAt); // agrega ctx.failpoint() para las fallas simuladas
}

// Cierra las 4 conexiones. allSettled: aunque una falle al cerrar, se intentan las demás.
export async function cerrarContexto() {
  await Promise.allSettled([mongo.close(), redis.close(), neo4j.close(), cassandra.close()]);
}