import { ErrorNegocio } from '../saga/errores.js';

// Valida que el alumno pueda cursar la materia según SU plan. Lo usan P2, P3 y P5.
// Es solo lectura (Mongo): no escribe nada, por eso no necesita compensación.
// Devuelve el estudiante y el plan que incluye la materia.
export async function resolverPlan(ctx, alumno_id, materia_id) {
  const est = await ctx.mongo.getEstudiante(alumno_id);
  if (!est) throw new ErrorNegocio('ALUMNO_INEXISTENTE', `No existe el alumno ${alumno_id}`);
  let hayPlanNoHabilitado = false;
  // Un alumno puede tener varios planes (cambio de plan): se busca el que incluye la materia.
  for (const p of est.planes ?? []) {
    const plan = await ctx.mongo.getPlan(p.plan_id);
    if (!plan || !plan.materias.includes(materia_id)) continue;
    // Un plan 'pendiente_habilitacion' (P1 todavía no terminó de cargarse) no se puede usar.
    if (plan.estado !== 'habilitado') { hayPlanNoHabilitado = true; continue; }
    return { estudiante: est, plan };
  }
  // Se distinguen los dos rechazos para dar un motivo claro (ErrorNegocio -> estado RECHAZADA).
  throw hayPlanNoHabilitado
    ? new ErrorNegocio('PLAN_NO_HABILITADO', 'El plan que incluye la materia no está habilitado')
    : new ErrorNegocio('MATERIA_FUERA_DE_PLAN', `La materia ${materia_id} no pertenece a ningún plan del alumno`);
}