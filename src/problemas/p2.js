import { ErrorNegocio } from '../saga/errores.js';
import { ejecutarSaga } from '../saga/runner.js';
import { estadoPorMateria, cumpleRequisito } from '../dominio/estados.js';
import { reservarCupo, liberarCupo } from '../servicios/cupos.js';
import { resolverPlan } from './comun.js';

// PROBLEMA 2 — INSCRIPCIÓN A CURSADA. Motores: Mongo, Neo4j, Cassandra, Redis.
//   input: { alumno_id, comision_id }
// Una saga = lista de pasos. El runner los ejecuta en orden y, si uno falla, llama a
// `compensar` de los pasos ya iniciados, en orden inverso (ver runner.js).
// Convención: `datos` es la "mochila" de la saga. Lo que un paso devuelve se guarda
// en `datos` (y en saga_log), y los pasos siguientes lo leen de ahí.
export const p2Def = {
  nombre: 'p2-inscripcion-cursada',
  pasos: [
    // ---------- PASO 1: SOLO LECTURA (Mongo). Sin compensar: no escribe nada.
    {
      nombre: 'leer-comision',
      async accion(ctx, datos, { alumno_id, comision_id }) {
        const com = await ctx.mongo.getComision(comision_id);
        // ErrorNegocio => la saga termina RECHAZADA (no es una falla técnica).
        if (!com) throw new ErrorNegocio('COMISION_INEXISTENTE', `No existe la comisión ${comision_id}`);
        // Valida que la materia esté en un plan HABILITADO del alumno (ver comun.js).
        const { plan } = await resolverPlan(ctx, alumno_id, com.materia_id);
        // Todo lo que devuelve va a la mochila `datos` para los pasos siguientes.
        return {
          materia_id: com.materia_id,
          plan_id: plan._id,
          cuatrimestre_id: com.cuatrimestre_id,
          docente_id: com.docente_ids?.[0] ?? null,
          // IDEMPOTENCIA: la fecha se fija UNA sola vez, acá. Es parte de la clave de
          // Cassandra (fecha_inscripcion), así que si un reintento la regenerara,
          // crearía una fila nueva en lugar de reescribir la misma.
          fecha_inscripcion: new Date().toISOString(),
        };
      },
    },

    // ---------- PASO 2: SOLO LECTURA (Neo4j + Cassandra). Sin compensar.
    {
      nombre: 'validar-correlatividades',
      async accion(ctx, { plan_id, materia_id }, { alumno_id, comision_id }) {
        // Tres lecturas independientes en paralelo:
        //  - Neo4j: qué materias requiere esta materia EN ESTE PLAN
        //  - Cassandra: todas las calificaciones del alumno (una sola partición)
        //  - Cassandra: sus inscripciones actuales (una sola partición)
        const [reqs, filas, inscripciones] = await Promise.all([
          ctx.neo4j.requisitos(plan_id, materia_id),
          ctx.cass.trayectoria(alumno_id),
          ctx.cass.inscripcionesAlumno(alumno_id),
        ]);
        // Calcula el estado de cada materia (aprobada / regular / libre) desde las notas.
        const estados = estadoPorMateria(filas);
        const actual = estados.get(materia_id)?.estado;
        if (actual === 'aprobada' || actual === 'regular') {
          throw new ErrorNegocio('MATERIA_YA_REGULAR_O_APROBADA', `La materia ya está ${actual}: corresponde rendir final, no cursar`);
        }
        // Correlativas que NO cumple (tipo 'aprobada' exige aprobada; 'regularizada' acepta regular o aprobada).
        const pendientes = reqs.filter((r) => !cumpleRequisito(r, estados));
        if (pendientes.length) throw new ErrorNegocio('CORRELATIVAS_PENDIENTES', 'Correlativas pendientes', pendientes);
        // Dos inscripciones a la misma comisión no son válidas. Se filtra en Node sobre una
        // sola partición (sin ALLOW FILTERING).
        if (inscripciones.some((i) => i.comision_id === comision_id)) throw new ErrorNegocio('YA_INSCRIPTO', 'El alumno ya está inscripto en esa comisión');
        return {}; // no aporta datos nuevos
      },
    },

    // ---------- PASO 3: ESCRIBE en Redis. Primer paso con compensación.
    {
      nombre: 'reservar-cupo',
      async accion(ctx, datos, { alumno_id, comision_id }) {
        // Reserva atómica (script Lua): decrementa el contador solo si hay lugar y el alumno no lo tenía.
        const r = await reservarCupo(ctx, 'comision', comision_id, alumno_id);
        if (r === 'SIN_CUPO') throw new ErrorNegocio('SIN_CUPO', 'La comisión no tiene cupo disponible');
        return { cupo: r }; // 'OK' o 'YA' (un reintento: ya tenía el lugar, no descuenta de nuevo)
      },
      // COMPENSACIÓN: devolver el lugar. Es idempotente: si el alumno no tenía lugar, no suma nada.
      compensar: (ctx, datos, { alumno_id, comision_id }) => liberarCupo(ctx, 'comision', comision_id, alumno_id),
    },

    // ---------- PASO 4: ESCRIBE en Cassandra. El "commit" durable de la inscripción.
    {
      nombre: 'registrar-inscripcion',
      accion: async (ctx, d, { alumno_id, comision_id }) => {
        // LOGGED BATCH: escribe la fila en inscripciones_por_alumno y en
        // inscripciones_por_comision como una unidad (o se aplican las dos o ninguna).
        // Reescribir la misma clave es un upsert: reintentar no duplica.
        await ctx.cass.aplicarInscripciones({
          insertar: [{ alumno_id, comision_id, materia_id: d.materia_id, docente_id: d.docente_id, cuatrimestre_id: d.cuatrimestre_id, fecha_inscripcion: d.fecha_inscripcion }],
        });
        return {};
      },
      // COMPENSACIÓN: borra las dos filas con la MISMA clave que se escribió (por eso
      // hace falta guardar fecha_inscripcion en `datos`). Borrar lo que no existe no da error.
      compensar: (ctx, d, { alumno_id, comision_id }) =>
        ctx.cass.aplicarInscripciones({
          borrar: [{ alumno_id, comision_id, materia_id: d.materia_id, fecha_inscripcion: d.fecha_inscripcion }],
        }),
    },
  ],

  // Qué devuelve la saga al terminar bien (se guarda en saga_log como resultado).
  resultado: (d, { alumno_id, comision_id }) => ({
    alumno_id, comision_id, materia_id: d.materia_id, cuatrimestre_id: d.cuatrimestre_id, fecha_inscripcion: d.fecha_inscripcion,
  }),
};

// Función que usa el CLI: ejecuta la definición con el runner.
// `opts` puede traer { operacion_id } para reintentar la misma operación.
export const p2Inscribir = (ctx, input, opts) => ejecutarSaga(ctx, p2Def, input, opts);