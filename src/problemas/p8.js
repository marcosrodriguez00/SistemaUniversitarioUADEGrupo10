import { ErrorNegocio } from '../saga/errores.js';
import { ejecutarSaga } from '../saga/runner.js';
import { estadoPorMateria, estadoSegunTipo } from '../dominio/estados.js';
import { CUATRIMESTRE_ACTUAL } from '../config.js';
import { armarTrayectoria } from './p6.js';

// PROBLEMA 8 — RECTIFICACIÓN DE NOTA. Motores: Cassandra + Neo4j.
//   input: { alumno_id, materia_id, nueva_nota, comision_id?, fecha_evaluacion?, plan_id? }
// Sin fecha_evaluacion se rectifica el último final de esa materia.
// El valor ANTERIOR se guarda en `datos` (que el runner persiste en saga_log): así se puede
// revertir aunque el proceso se caiga a mitad. Guardarlo solo en memoria no sobreviviría.
export const p8Def = {
  nombre: 'p8-rectificacion-nota',
  pasos: [
    // ---------- PASO 1: SOLO LECTURA. Encuentra la fila y calcula el antes y el después.
    {
      nombre: 'leer-nota',
      async accion(ctx, datos, { alumno_id, materia_id, nueva_nota, comision_id, fecha_evaluacion, plan_id }) {
        if (!(nueva_nota >= 0 && nueva_nota <= 10)) throw new ErrorNegocio('NOTA_FUERA_DE_RANGO', 'La nota debe estar entre 0 y 10');
        const filas = await ctx.cass.trayectoria(alumno_id);
        // Se busca la fila a rectificar en memoria, sobre una sola partición (sin ALLOW FILTERING).
        const fila = fecha_evaluacion
          ? filas.find((f) => +new Date(f.fecha_evaluacion) === +new Date(fecha_evaluacion) && f.materia_id === materia_id && (!comision_id || f.comision_id === comision_id))
          : [...filas].reverse().find((f) => f.materia_id === materia_id && f.tipo === 'final' && (!comision_id || f.comision_id === comision_id));
        if (!fila) throw new ErrorNegocio('NOTA_INEXISTENTE', 'No se encontró la nota a rectificar');

        // Plan del alumno que incluye la materia (necesario para consultar correlatividades).
        let pid = plan_id;
        if (!pid) {
          const est = await ctx.mongo.getEstudiante(alumno_id);
          for (const p of est?.planes ?? []) {
            const plan = await ctx.mongo.getPlan(p.plan_id);
            if (plan?.materias.includes(materia_id)) { pid = plan._id; break; }
          }
        }
        if (!pid) throw new ErrorNegocio('MATERIA_FUERA_DE_PLAN', 'No se pudo determinar el plan del alumno para esa materia');

        // Estado de la materia ANTES, y DESPUÉS de aplicar la nota nueva (simulado en memoria).
        const antes = estadoPorMateria(filas).get(materia_id);
        const estadoNuevo = estadoSegunTipo(fila.tipo, nueva_nota);
        const despues = estadoPorMateria(filas.map((f) => (f === fila ? { ...f, nota: nueva_nota, estado: estadoNuevo } : f))).get(materia_id);
        return {
          plan_id: pid,
          // CLAVE de la fila: la acción y la compensación la usan para tocar la MISMA fila.
          fila_pk: { fecha_evaluacion: new Date(fila.fecha_evaluacion).toISOString(), materia_id, comision_id: fila.comision_id },
          anterior: { nota: fila.nota, estado: fila.estado },  // lo que usará la COMPENSACIÓN
          nuevo: { nota: nueva_nota, estado: estadoNuevo },
          aprobada_en: antes?.aprobada_en ? antes.aprobada_en.toISOString() : null,
          estado_materia_antes: antes?.estado ?? null,
          estado_materia_despues: despues?.estado ?? null,
          // Solo si la materia DEJA de estar aprobada hay que revisar lo que dependía de ella.
          cambia_estado: antes?.estado === 'aprobada' && despues?.estado !== 'aprobada',
        };
      },
    },

    // ---------- PASO 2: ESCRIBE en Cassandra. Nota y estado juntos, en una sola UPDATE.
    {
      nombre: 'rectificar',
      accion: async (ctx, d, { alumno_id }) => {
        // `IF EXISTS` (en el repo): nunca crea una fila fantasma si no existe.
        await ctx.cass.actualizarCalificacion({ alumno_id, ...d.fila_pk }, d.nuevo);
        return {};
      },
      // COMPENSACIÓN: reescribir el valor anterior. Idempotente (siempre deja el mismo valor).
      // El `if` protege el caso en que el paso 1 ni llegó a completarse.
      compensar: async (ctx, d, { alumno_id }) => {
        if (d.fila_pk && d.anterior) await ctx.cass.actualizarCalificacion({ alumno_id, ...d.fila_pk }, d.anterior);
      },
    },

    // ---------- PASO 3: SOLO LECTURA. Qué inscripciones posteriores dependían de esa materia.
    {
      nombre: 'identificar-dependientes',
      async accion(ctx, d, { alumno_id, materia_id }) {
        if (!d.cambia_estado) return { dependientes: [] }; // sin cambio de estado no hay nada que revisar
        // Neo4j: todas las materias que dependen (directa o indirectamente) de esta.
        const materias = new Set(await ctx.neo4j.dependientes(d.plan_id, materia_id));
        const desde = new Date(d.aprobada_en);
        // Cassandra: inscripciones del alumno a esas materias, POSTERIORES a la aprobación original.
        const dependientes = (await ctx.cass.inscripcionesAlumno(alumno_id))
          .filter((i) => materias.has(i.materia_id) && new Date(i.fecha_inscripcion) > desde && !i.en_revision)
          .map((i) => ({ fecha_inscripcion: new Date(i.fecha_inscripcion).toISOString(), materia_id: i.materia_id, comision_id: i.comision_id }));
        return { dependientes };
      },
    },

    // ---------- PASO 4: ESCRIBE en Cassandra, varias filas (por eso hay un failpoint a mitad).
    {
      nombre: 'marcar-en-revision',
      async accion(ctx, d, { alumno_id }) {
        const lista = d.dependientes;
        for (let i = 0; i < lista.length; i++) {
          await ctx.cass.marcarRevision({ alumno_id, ...lista[i] }, true);
          // Falla simulada A MITAD del marcado: la mitad ya está marcada y hay que deshacerla.
          if (i + 1 === Math.ceil(lista.length / 2)) ctx.failpoint('marcado-medio');
        }
        return {};
      },
      // COMPENSACIÓN: desmarcar TODAS (también las que no llegaron a marcarse: es inofensivo).
      compensar: async (ctx, d, { alumno_id }) => {
        for (const dep of d.dependientes ?? []) await ctx.cass.marcarRevision({ alumno_id, ...dep }, false);
      },
    },
  ],
  resultado: (d) => ({
    cambia_estado: d.cambia_estado,
    estado_materia: { antes: d.estado_materia_antes, despues: d.estado_materia_despues },
    nota: { anterior: d.anterior, nueva: d.nuevo },
    inscripciones_en_revision: d.dependientes,
  }),
};

export const p8Rectificar = (ctx, input, opts) => ejecutarSaga(ctx, p8Def, input, opts);

// P8 (parte 2) — TRAZABILIDAD: dado un alumno_id, junta datos de los 4 motores.
// Solo lectura. No hay joins entre motores: cada uno responde con su dato y se arma en Node.
export async function p8Trazabilidad(ctx, { alumno_id }) {
  const est = await ctx.mongo.getEstudiante(alumno_id);                                   // Mongo: datos del alumno
  if (!est) throw new ErrorNegocio('ALUMNO_INEXISTENTE', `No existe el alumno ${alumno_id}`);
  const plan_id = est.planes?.[0]?.plan_id;
  const [plan, filas, inscripciones] = await Promise.all([                                 // lecturas independientes en paralelo
    ctx.mongo.getPlan(plan_id),                                                            // Mongo: plan
    ctx.cass.trayectoria(alumno_id),                                                       // Cassandra: notas
    ctx.cass.inscripcionesAlumno(alumno_id),                                               // Cassandra: inscripciones
  ]);
  const estados = estadoPorMateria(filas);
  const aprobadas = [...estados].filter(([, e]) => e.estado === 'aprobada').map(([id]) => id);
  const regulares = [...estados].filter(([, e]) => e.estado === 'regular').map(([id]) => id);
  const habilitadas = await ctx.neo4j.cursables(plan_id, aprobadas, regulares);            // Neo4j: qué puede cursar
  return {
    alumno: { alumno_id, nombre: `${est.nombre} ${est.apellido}`, numero_legajo: est.numero_legajo },
    plan: { plan_id, nombre: plan?.nombre, estado: plan?.estado },
    trayectoria: armarTrayectoria(alumno_id, filas, plan),
    // "Activa" = inscripción del cuatrimestre actual (configurado en .env).
    inscripciones_activas: inscripciones
      .filter((i) => i.cuatrimestre_id === CUATRIMESTRE_ACTUAL)
      .map((i) => ({ comision_id: i.comision_id, materia_id: i.materia_id, fecha_inscripcion: i.fecha_inscripcion, en_revision: !!i.en_revision })),
    materias_habilitadas: habilitadas,
  };
}