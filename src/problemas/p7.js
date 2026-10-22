import { ErrorNegocio } from '../saga/errores.js';
import { estadoPorMateria, materiasConEstado } from '../dominio/estados.js';

// PROBLEMA 7 — CONSULTAS SOBRE EL PLAN. Solo lectura: no hay saga ni compensación.

// P7a — ¿Qué puedo cursar el próximo cuatrimestre?
// Cassandra aporta lo que el alumno YA hizo; Neo4j aporta la ESTRUCTURA del plan.
// Se combinan en Node: no hay joins entre motores.
export async function p7PuedoCursar(ctx, { alumno_id, plan_id }) {
  const est = await ctx.mongo.getEstudiante(alumno_id);
  if (!est) throw new ErrorNegocio('ALUMNO_INEXISTENTE', `No existe el alumno ${alumno_id}`);
  const pid = plan_id ?? est.planes?.[0]?.plan_id;
  // Una partición de Cassandra → estado de cada materia (aprobada / regular / libre).
  const estados = estadoPorMateria(await ctx.cass.trayectoria(alumno_id));
  // Neo4j recibe las listas de aprobadas y regulares y devuelve las materias del plan
  // que NO están hechas y cuyos requisitos se cumplen (ver neo4j.repo.js → cursables).
  const ids = await ctx.neo4j.cursables(pid, materiasConEstado(estados, 'aprobada'), materiasConEstado(estados, 'regular'));
  // Mongo traduce ids a nombres legibles.
  const materias = await ctx.mongo.getMaterias(ids);
  return { alumno_id, plan_id: pid, cursables: materias.map((m) => ({ materia_id: m._id, codigo: m.codigo, nombre: m.nombre })) };
}

// P7b — ¿Qué materias destraba aprobar una materia, directa o indirectamente?
// Solo depende de la estructura del plan, no del alumno: basta Neo4j (recorrido transitivo).
export async function p7Destraba(ctx, { materia_id, plan_id }) {
  const ids = await ctx.neo4j.dependientes(plan_id, materia_id);
  return { materia_id, plan_id, destraba: ids, cantidad: ids.length };
}

// P7c — Cadena de correlatividades más larga del plan (camino más largo en el grafo).
export async function p7CadenaMasLarga(ctx, { plan_id }) {
  const cadena = await ctx.neo4j.cadenaMasLarga(plan_id);
  return { plan_id, longitud: cadena.length, cadena };
}