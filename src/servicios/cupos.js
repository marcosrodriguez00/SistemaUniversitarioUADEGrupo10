// CUPOS EN TIEMPO REAL. Conecta Redis (el contador rápido) con Mongo y Cassandra (la verdad).
// Redis NO es la fuente de verdad: si se pierde el contador (reinicio, flush) se reconstruye
// como  cupo_maximo (Mongo) - inscriptos (Cassandra).
// ns = 'comision' | 'mesa'  (el mismo mecanismo sirve para cursadas y mesas de examen)

// Reconstruye el contador de una comisión/mesa desde las fuentes de verdad.
export async function reconstruirCupo(ctx, ns, id) {
  const entidad = ns === 'comision' ? await ctx.mongo.getComision(id) : await ctx.mongo.getMesa(id);
  if (!entidad) throw new Error(`No existe ${ns} ${id} en Mongo`);
  // Se lee UNA partición de Cassandra (todos los inscriptos de esa comisión/mesa).
  const inscriptos = ns === 'comision' ? await ctx.cass.inscripcionesComision(id) : await ctx.cass.inscripcionesMesaMesa(id);
  const alumnos = inscriptos.map((r) => r.alumno_id);
  // Se inicializan el contador Y el set de reservas con los alumnos ya inscriptos.
  // (LUA_INICIALIZAR solo escribe si la clave NO existe: no pisa un contador vivo.)
  // Limitación conocida: una reserva "en vuelo" (tomada en Redis pero todavía no escrita en
  // Cassandra) no se ve acá. Es el costo de que Redis y Cassandra no compartan transacción.
  await ctx.redis.inicializar(ns, id, entidad.cupo_maximo - alumnos.length, alumnos);
}

// PASO DE SAGA "reservar cupo": toma un lugar de forma atómica (script Lua).
// Devuelve 'OK' | 'YA' (el alumno ya tenía lugar: idempotente) | 'SIN_CUPO'
export async function reservarCupo(ctx, ns, id, alumno_id) {
  let r = await ctx.redis.reservar(ns, id, alumno_id);
  // Si Redis no conoce esa comisión (primer uso o datos perdidos), reconstruye y reintenta.
  if (r === 'SIN_INICIALIZAR') {
    await reconstruirCupo(ctx, ns, id);
    r = await ctx.redis.reservar(ns, id, alumno_id);
  }
  return r;
}

// COMPENSACIÓN de reservarCupo. Idempotente: si el alumno no tenía lugar reservado,
// LUA_LIBERAR devuelve 0 y no suma nada (no se "regalan" lugares de más).
export const liberarCupo = (ctx, ns, id, alumno_id) => ctx.redis.liberar(ns, id, alumno_id);

// Se usa en P3 (cambio de comisión): si ya se liberó el lugar de la comisión origen y algo
// falla, hay que volver a tomarlo. Es la COMPENSACIÓN de liberarCupo. No chequea el máximo:
// ese lugar era del alumno, así que tiene que poder recuperarlo aunque la comisión se haya llenado.
export const retomarCupo = (ctx, ns, id, alumno_id) => ctx.redis.forzar(ns, id, alumno_id);