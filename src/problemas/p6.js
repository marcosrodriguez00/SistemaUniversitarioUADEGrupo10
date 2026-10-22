import { ErrorNegocio } from '../saga/errores.js';
import { estadoPorMateria, promedio } from '../dominio/estados.js';

// Función PURA: recibe las filas de Cassandra y el plan de Mongo, y arma la trayectoria.
// No consulta nada (por eso se puede probar sin bases de datos).
export function armarTrayectoria(alumno_id, filas, plan) {
  const estados = estadoPorMateria(filas); // estado actual de cada materia (ver estados.js)

  // CURSADAS: se agrupan las filas por (materia, comision). Una recursada es otra comisión
  // de la misma materia, por eso comision_id forma parte de la clave de agrupación.
  const grupos = new Map();
  for (const f of filas) {
    const k = `${f.materia_id}|${f.comision_id}`;
    if (!grupos.has(k)) grupos.set(k, { materia_id: f.materia_id, comision_id: f.comision_id, evaluaciones: [] });
    grupos.get(k).evaluaciones.push({ fecha: f.fecha_evaluacion, tipo: f.tipo, nota: f.nota, estado: f.estado, mesa_id: f.mesa_id ?? null });
  }
  // Dentro de cada cursada: evaluaciones en orden cronológico; su estado es el de la última.
  const porMateria = new Map();
  for (const g of grupos.values()) {
    g.evaluaciones.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    g.estado = g.evaluaciones.at(-1).estado;
    g.inicio = g.evaluaciones[0].fecha;
    if (!porMateria.has(g.materia_id)) porMateria.set(g.materia_id, []);
    porMateria.get(g.materia_id).push(g);
  }
  // Se numeran las cursadas de cada materia: la 2.ª o posterior se marca como recursada.
  const cursadas = [];
  for (const lista of porMateria.values()) {
    lista.sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
    lista.forEach((g, i) => cursadas.push({ ...g, numero_cursada: i + 1, recursada: i > 0 }));
  }
  cursadas.sort((a, b) => new Date(a.inicio) - new Date(b.inicio));

  // PROMEDIOS: con aplazos (todos los finales) y sin aplazos (solo los aprobados).
  const finales = filas.filter((f) => f.tipo === 'final');
  const conAplazos = promedio(finales.map((f) => f.nota));
  const sinAplazos = promedio(finales.filter((f) => f.estado === 'aprobada').map((f) => f.nota));

  // AVANCE: materias aprobadas que son del plan / total de materias del plan (dato de Mongo).
  const aprobadasPlan = [...estados].filter(([id, e]) => e.estado === 'aprobada' && plan.materias.includes(id)).length;
  return {
    alumno_id,
    plan_id: plan._id,
    cursadas,
    finales_rendidos: finales.map((f) => ({ fecha: f.fecha_evaluacion, materia_id: f.materia_id, comision_id: f.comision_id, mesa_id: f.mesa_id, nota: f.nota, estado: f.estado })),
    promedio_con_aplazos: conAplazos,
    promedio_sin_aplazos: sinAplazos,
    materias_aprobadas: aprobadasPlan,
    total_materias_plan: plan.materias.length,
    porcentaje_avance: Math.round((aprobadasPlan / plan.materias.length) * 10000) / 100,
  };
}

// PROBLEMA 6 — TRAYECTORIA ACADÉMICA (Cassandra + Mongo). Solo lectura: sin saga.
// Costo: UNA lectura de partición en Cassandra + UNA lectura del plan en Mongo.
export async function p6Trayectoria(ctx, { alumno_id, plan_id }) {
  const est = await ctx.mongo.getEstudiante(alumno_id);
  if (!est) throw new ErrorNegocio('ALUMNO_INEXISTENTE', `No existe el alumno ${alumno_id}`);
  // Si no se indica plan, se usa el primero del alumno.
  const pid = plan_id ?? est.planes?.[0]?.plan_id;
  // Las dos lecturas son independientes: se hacen en paralelo.
  const [filas, plan] = await Promise.all([ctx.cass.trayectoria(alumno_id), ctx.mongo.getPlan(pid)]);
  if (!plan) throw new ErrorNegocio('PLAN_INEXISTENTE', `No existe el plan ${pid}`);
  return armarTrayectoria(alumno_id, filas, plan);
}