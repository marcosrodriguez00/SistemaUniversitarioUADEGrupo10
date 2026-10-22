import { ErrorNegocio } from '../saga/errores.js';
import { ejecutarSaga } from '../saga/runner.js';

// PROBLEMA 1 — CARGA DE UN PLAN DE ESTUDIOS. Motores: Mongo + Neo4j.
//   input: { plan_id, nombre, carrera_id,
//            materias: [{ materia_id, codigo, nombre, creditos }],
//            correlatividades: [{ materia, requiere, tipo: 'regularizada'|'aprobada' }] }
//
// DECISIÓN DE DISEÑO (informe, P1): si falla Neo4j NO se borra lo de Mongo. El plan queda
// 'pendiente_habilitacion' (nadie puede inscribirse a sus materias: ver resolverPlan en comun.js)
// y sirve de punto de reintento, porque todas las cargas son idempotentes (upsert / MERGE).
// Por eso el ÚNICO paso con compensación es 'habilitar'.

// Detecta ciclos en las correlatividades (A requiere B y B requiere A → imposible de cursar).
// Recorrido en profundidad: estado 1 = "en la ruta actual", 2 = "ya explorado".
// Si se vuelve a un nodo en estado 1, hay un ciclo.
function detectarCiclo(ids, correlatividades) {
  const sig = new Map(ids.map((i) => [i, []]));
  for (const c of correlatividades) sig.get(c.materia).push(c.requiere);
  const estado = new Map();
  const visitar = (n) => {
    if (estado.get(n) === 1) return true;
    if (estado.get(n) === 2) return false;
    estado.set(n, 1);
    if (sig.get(n).some(visitar)) return true;
    estado.set(n, 2);
    return false;
  };
  return ids.some(visitar);
}

// Las correlatividades se cargan en lotes chicos. Permite simular una falla A MITAD de la
// carga (failpoint 'correlatividad-medio') y mostrar que un reintento termina el trabajo.
const TAM_LOTE = 5;

export const p1Def = {
  nombre: 'p1-carga-plan',
  pasos: [
    // ---------- PASO 1: SOLO VALIDACIÓN. Nada se escribe, nada que deshacer.
    {
      nombre: 'validar-plan',
      async accion(ctx, datos, { materias, correlatividades }) {
        const ids = materias.map((m) => m.materia_id);
        for (const c of correlatividades) {
          if (!ids.includes(c.materia) || !ids.includes(c.requiere)) {
            throw new ErrorNegocio('CORRELATIVIDAD_INVALIDA', `Correlatividad con materia fuera del plan: ${c.materia} -> ${c.requiere}`);
          }
          if (!['regularizada', 'aprobada'].includes(c.tipo)) throw new ErrorNegocio('TIPO_INVALIDO', `Tipo inválido: ${c.tipo}`);
          if (c.materia === c.requiere) throw new ErrorNegocio('CORRELATIVIDAD_INVALIDA', `${c.materia} se requiere a sí misma`);
        }
        if (detectarCiclo(ids, correlatividades)) throw new ErrorNegocio('CICLO_EN_CORRELATIVIDADES', 'El plan tiene un ciclo de correlatividades');
        return {};
      },
    },

    // ---------- PASO 2: ESCRIBE en Mongo. Idempotente (upsert), por eso no lleva compensación.
    {
      nombre: 'guardar-plan',
      async accion(ctx, datos, { plan_id, nombre, carrera_id, materias }) {
        await ctx.mongo.upsertMaterias(materias); // no pisa materias que ya existen (pueden estar en otro plan)
        // El plan queda 'pendiente_habilitacion' hasta que TODO esté cargado.
        await ctx.mongo.upsertPlan({ plan_id, nombre, carrera_id, materias: materias.map((m) => m.materia_id) });
        return {};
      },
    },

    // ---------- PASO 3: ESCRIBE en Neo4j. MERGE = crea si no existe: reintentar no duplica.
    {
      nombre: 'cargar-correlatividades',
      async accion(ctx, datos, { plan_id, materias, correlatividades }) {
        await ctx.neo4j.asegurarPlanYMaterias(plan_id, materias.map((m) => m.materia_id));
        const lotes = [];
        for (let i = 0; i < correlatividades.length; i += TAM_LOTE) lotes.push(correlatividades.slice(i, i + TAM_LOTE));
        const mitad = Math.ceil(lotes.length / 2);
        for (let i = 0; i < lotes.length; i++) {
          await ctx.neo4j.cargarCorrelatividades(plan_id, lotes[i]);
          // Falla simulada a mitad: la mitad de las relaciones ya está en Neo4j.
          if (i + 1 === mitad) ctx.failpoint('correlatividad-medio');
        }
        return {};
      },
    },

    // ---------- PASO 4: ESCRIBE en Mongo. El "commit": recién acá el plan queda utilizable.
    {
      nombre: 'habilitar',
      async accion(ctx, datos, { plan_id }) {
        await ctx.mongo.setPlanEstado(plan_id, 'habilitado');
        return {};
      },
      // COMPENSACIÓN: si algo falla después de habilitar, vuelve a 'pendiente_habilitacion'.
      async compensar(ctx, datos, { plan_id }) {
        await ctx.mongo.setPlanEstado(plan_id, 'pendiente_habilitacion');
      },
    },
  ],
  resultado: (datos, { plan_id, materias, correlatividades }) => ({
    plan_id, estado: 'habilitado', materias: materias.length, correlatividades: correlatividades.length,
  }),
};

export const p1CargarPlan = (ctx, input, opts) => ejecutarSaga(ctx, p1Def, input, opts);