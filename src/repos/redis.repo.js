import { claveCupo, claveReservas } from '../ids.js';

// REDIS = CUPO EN TIEMPO REAL. Es el recurso en disputa de las sagas P2, P3 y P5.
//
// Por qué scripts Lua: Redis ejecuta cada script COMPLETO sin que otro cliente se
// meta en el medio. "Chequear que hay lugar" y "tomarlo" son un solo paso atómico, así que
// con 100 alumnos compitiendo por el último lugar entra exactamente uno.
//
// Por qué un set además del contador: el set de reservas hace IDEMPOTENTES tanto la
// reserva como la compensación. Un alumno ocupa a lo sumo un lugar, sin importar cuántas
// veces se reintente.

// Paso "tomar cupo" de la saga. Devuelve: -1 el contador no existe | 2 el alumno ya
// tenía lugar (reintento, no consume otro) | 0 sin cupo | 1 lugar tomado.
const LUA_RESERVAR = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return 2 end
if tonumber(redis.call('GET', KEYS[1])) <= 0 then return 0 end
redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
return 1`;

// COMPENSACIÓN de "tomar cupo". Solo devuelve el lugar si el alumno realmente lo tenía
// (SREM borró algo). Compensar dos veces, o compensar un paso que nunca llegó a escribir,
// no suma de más: por eso es seguro compensar siempre, sin preguntar si el paso se hizo.
const LUA_LIBERAR = `
if redis.call('SREM', KEYS[2], ARGV[1]) == 1 then
  redis.call('INCR', KEYS[1])
  return 1
end
return 0`;

// COMPENSACIÓN de "liberar cupo" (P3): vuelve a tomar el lugar original sin chequear el
// máximo, porque ese lugar era del alumno. Es idempotente por el mismo motivo (SADD).
const LUA_FORZAR = `
if redis.call('SADD', KEYS[2], ARGV[1]) == 1 then
  redis.call('DECR', KEYS[1])
  return 1
end
return 0`;

// Reconstruye el contador cuando Redis lo perdió (reinicio, falla). Redis NO es la fuente de
// verdad: el cupo se recalcula como cupo_maximo (Mongo) - inscriptos (Cassandra).
// Solo escribe si el contador NO existe, para no pisar uno vivo si dos procesos reconstruyen a la vez.
const LUA_INICIALIZAR = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
for i = 2, #ARGV do redis.call('SADD', KEYS[2], ARGV[i]) end
return 1`;

export function crearRedisRepo(redis) {
  // Las dos claves de un mismo cupo: [contador, set de reservas]
  const keys = (ns, id) => [claveCupo(ns, id), claveReservas(ns, id)];
  return {
    // Traduce el número que devuelve Lua a un texto que entienden las sagas.
    async reservar(ns, id, alumno_id) {
      const r = Number(await redis.eval(LUA_RESERVAR, 2, ...keys(ns, id), alumno_id));
      return { [-1]: 'SIN_INICIALIZAR', 0: 'SIN_CUPO', 1: 'OK', 2: 'YA' }[r];
    },
    async liberar(ns, id, alumno_id) {
      return Number(await redis.eval(LUA_LIBERAR, 2, ...keys(ns, id), alumno_id)) === 1;
    },
    async forzar(ns, id, alumno_id) {
      return Number(await redis.eval(LUA_FORZAR, 2, ...keys(ns, id), alumno_id)) === 1;
    },
    async inicializar(ns, id, disponible, alumnos = []) {
      return Number(await redis.eval(LUA_INICIALIZAR, 2, ...keys(ns, id), String(disponible), ...alumnos)) === 1;
    },
    // Lecturas para mostrar evidencia antes/después en la demo (no participan de las sagas).
    async disponible(ns, id) {
      const v = await redis.get(claveCupo(ns, id));
      return v === null ? null : Number(v);
    },
    async reservas(ns, id) {
      return redis.smembers(claveReservas(ns, id));
    },
  };
}