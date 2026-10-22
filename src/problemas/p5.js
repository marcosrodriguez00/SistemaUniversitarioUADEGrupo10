import { ErrorNegocio } from '../saga/errores.js';
import { ejecutarSaga } from '../saga/runner.js';
import { estadoPorMateria } from '../dominio/estados.js';
import { reservarCupo, liberarCupo } from '../servicios/cupos.js';
import { resolverPlan } from './comun.js';

// PROBLEMA 5 — INSCRIPCIÓN A MESA DE FINAL. Motores: Mongo, Neo4j, Cassandra, Redis.
//   input: { alumno_id, mesa_id }
// Mismo patrón que P2: lecturas (sin compensación) → cupo en Redis → registro en Cassandra.
// Valida regularidad vigente + correlativas APROBADAS. Se revalidan acá: no se asume
// que siguen vigentes desde que se cursó.
export const p5Def = {
  nombre: 'p5-inscripcion-mesa',
  pasos: [
    // ---------- PASO 1: SOLO LECTURA (Mongo). Sin compensar.
    {
      nombre: 'leer-mesa',
      async accion(ctx, datos, { alumno_id, mesa_id }) {
        const mesa = await ctx.mongo.getMesa(mesa_id);
        if (!mesa) throw new ErrorNegocio('MESA_INEXISTENTE', `No existe la mesa ${mesa_id}`);
        if (new Date(mesa.fecha) < new Date()) throw new ErrorNegocio('MESA_VENCIDA', 'La mesa ya se rindió');
        const { plan } = await resolverPlan(ctx, alumno_id, mesa.materia_id);
        // fecha_mesa forma parte de la clave de Cassandra (inscripciones_mesa_por_alumno).
        // Se guarda en `datos`: la compensación borrará EXACTAMENTE esa fila.
        return { materia_id: mesa.materia_id, plan_id: plan._id, fecha_mesa: new Date(mesa.fecha).toISOString() };
      },
    },

    // ---------- PASO 2: SOLO LECTURA (Neo4j + Cassandra). Sin compensar.
    {
      nombre: 'validar',
      async accion(ctx, { plan_id, materia_id }, { alumno_id, mesa_id }) {
        // Tres lecturas en paralelo: correlativas (Neo4j), notas y mesas del alumno (Cassandra,
        // una partición cada una).
        const [reqs, filas, enMesas] = await Promise.all([
          ctx.neo4j.requisitos(plan_id, materia_id),
          ctx.cass.trayectoria(alumno_id),
          ctx.cass.inscripcionesMesaAlumno(alumno_id),
        ]);
        const estados = estadoPorMateria(filas);
        const propio = estados.get(materia_id)?.estado;
        if (propio === 'aprobada') throw new ErrorNegocio('YA_APROBADA', 'La materia ya está aprobada');
        // Para rendir final la materia tiene que estar REGULAR (ni libre ni sin cursar).
        if (propio !== 'regular') throw new ErrorNegocio('SIN_REGULARIDAD', `La materia está ${propio ?? 'sin cursar'}: se necesita regularidad vigente`);
        // A diferencia de P2: para rendir, TODAS las correlativas deben estar APROBADAS
        // (no alcanza con regulares), sin mirar el `tipo`.
        const pendientes = reqs.filter((r) => estados.get(r.requiere)?.estado !== 'aprobada');
        if (pendientes.length) throw new ErrorNegocio('CORRELATIVAS_PENDIENTES', 'Correlativas sin aprobar', pendientes);
        if (enMesas.some((m) => m.mesa_id === mesa_id)) throw new ErrorNegocio('YA_INSCRIPTO', 'Ya está inscripto en esa mesa');
        return {};
      },
    },

    // ---------- PASO 3: ESCRIBE en Redis. Mismo mecanismo que P2 pero con namespace 'mesa'.
    {
      nombre: 'reservar-cupo',
      async accion(ctx, datos, { alumno_id, mesa_id }) {
        const r = await reservarCupo(ctx, 'mesa', mesa_id, alumno_id);
        if (r === 'SIN_CUPO') throw new ErrorNegocio('SIN_CUPO', 'La mesa no tiene cupo');
        return {};
      },
      compensar: (ctx, d, { alumno_id, mesa_id }) => liberarCupo(ctx, 'mesa', mesa_id, alumno_id),
    },

    // ---------- PASO 4: ESCRIBE en Cassandra. El "commit" durable.
    {
      nombre: 'registrar-inscripcion',
      accion: async (ctx, d, { alumno_id, mesa_id }) => {
        // LOGGED BATCH sobre inscripciones_mesa_por_alumno e inscripciones_mesa_por_mesa:
        // las dos tablas quedan consistentes entre sí (todo o nada).
        await ctx.cass.aplicarInscripcionesMesa({ insertar: [{ alumno_id, mesa_id, materia_id: d.materia_id, fecha_mesa: d.fecha_mesa }] });
        return {};
      },
      // COMPENSACIÓN: borra las mismas filas, con la clave exacta guardada en `datos`.
      compensar: (ctx, d, { alumno_id, mesa_id }) =>
        ctx.cass.aplicarInscripcionesMesa({ borrar: [{ alumno_id, mesa_id, materia_id: d.materia_id, fecha_mesa: d.fecha_mesa }] }),
    },
  ],
  resultado: (d, { alumno_id, mesa_id }) => ({ alumno_id, mesa_id, materia_id: d.materia_id, fecha_mesa: d.fecha_mesa }),
};

export const p5InscribirMesa = (ctx, input, opts) => ejecutarSaga(ctx, p5Def, input, opts);