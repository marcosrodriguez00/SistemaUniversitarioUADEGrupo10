import { ErrorNegocio } from '../saga/errores.js';
import { ejecutarSaga } from '../saga/runner.js';
import { reservarCupo, liberarCupo, retomarCupo } from '../servicios/cupos.js';

// PROBLEMA 3 — CAMBIO DE COMISIÓN (misma materia, mismo cuatrimestre). Motores: Mongo, Redis, Cassandra.
//   input: { alumno_id, comision_origen, comision_destino }
//
// REGLA DE ORO DEL ORDEN: primero se asegura lo NUEVO, después se suelta lo VIEJO.
// Si se soltara el origen primero y el destino no tuviera cupo, el alumno quedaría sin
// lugar en ninguna comisión (peor que el estado inicial) y otro podría ocupar su lugar.
// Trade-off: si la compensación de 'liberar-origen' corre cuando otro alumno ya tomó ese
// lugar, el cupo puede quedar en -1 hasta reconciliar. Se prefiere eso a dejarlo sin lugar.
export const p3Def = {
  nombre: 'p3-cambio-comision',
  pasos: [
    // ---------- PASO 1: SOLO LECTURA. Todas las validaciones de negocio, sin escribir.
    {
      nombre: 'validar',
      async accion(ctx, datos, { alumno_id, comision_origen, comision_destino }) {
        if (comision_origen === comision_destino) throw new ErrorNegocio('MISMA_COMISION', 'Origen y destino son la misma comisión');
        const [o, dst] = await Promise.all([ctx.mongo.getComision(comision_origen), ctx.mongo.getComision(comision_destino)]);
        if (!o || !dst) throw new ErrorNegocio('COMISION_INEXISTENTE', 'Alguna de las comisiones no existe');
        if (o.materia_id !== dst.materia_id) throw new ErrorNegocio('OTRA_MATERIA', 'La comisión destino es de otra materia');
        if (o.cuatrimestre_id !== dst.cuatrimestre_id) throw new ErrorNegocio('OTRO_CUATRIMESTRE', 'La comisión destino es de otro cuatrimestre');
        // Una sola partición de Cassandra (todas las inscripciones del alumno); se filtra en Node.
        const insc = await ctx.cass.inscripcionesAlumno(alumno_id);
        const filaOrigen = insc.find((i) => i.comision_id === comision_origen);
        if (!filaOrigen) throw new ErrorNegocio('NO_INSCRIPTO_EN_ORIGEN', 'El alumno no está inscripto en la comisión de origen');
        if (insc.some((i) => i.comision_id === comision_destino)) throw new ErrorNegocio('YA_INSCRIPTO_EN_DESTINO', 'El alumno ya está en la comisión destino');
        return {
          materia_id: o.materia_id,
          cuatrimestre_id: o.cuatrimestre_id,
          docente_destino: dst.docente_ids?.[0] ?? null,
          // SE GUARDA la fila original completa. Sin esto, la compensación del paso 4 no
          // podría restaurar la inscripción exactamente como estaba (misma clave y mismos datos).
          fila_origen: {
            fecha_inscripcion: new Date(filaOrigen.fecha_inscripcion).toISOString(),
            docente_id: filaOrigen.docente_id ?? null,
            en_revision: filaOrigen.en_revision ?? false,
          },
          // Fecha de la inscripción nueva: se fija UNA vez (idempotencia, igual que en P2).
          fecha_nueva: new Date().toISOString(),
        };
      },
    },

    // ---------- PASO 2: ESCRIBE en Redis. Se asegura el lugar NUEVO primero.
    {
      nombre: 'reservar-destino',
      async accion(ctx, datos, { alumno_id, comision_destino }) {
        const r = await reservarCupo(ctx, 'comision', comision_destino, alumno_id);
        // Si no hay cupo, la saga se RECHAZA: el alumno no soltó nada, conserva su lugar actual.
        if (r === 'SIN_CUPO') throw new ErrorNegocio('SIN_CUPO_EN_DESTINO', 'No hay cupo en la comisión destino: el alumno conserva su lugar');
        return {};
      },
      compensar: (ctx, d, { alumno_id, comision_destino }) => liberarCupo(ctx, 'comision', comision_destino, alumno_id),
    },

    // ---------- PASO 3: ESCRIBE en Redis. Recién ahora se suelta el lugar VIEJO.
    {
      nombre: 'liberar-origen',
      accion: async (ctx, d, { alumno_id, comision_origen }) => {
        await liberarCupo(ctx, 'comision', comision_origen, alumno_id);
        return {};
      },
      // Su inversa es VOLVER A TOMAR el lugar. Usa `retomarCupo` (forzar) y no `reservarCupo`
      // porque la comisión origen pudo llenarse mientras tanto: ese lugar era del alumno.
      compensar: (ctx, d, { alumno_id, comision_origen }) => retomarCupo(ctx, 'comision', comision_origen, alumno_id),
    },

    // ---------- PASO 4: ESCRIBE en Cassandra. El "commit" durable del cambio.
    {
      nombre: 'mover-inscripcion',
      accion: async (ctx, d, { alumno_id, comision_origen, comision_destino }) => {
        // UN solo LOGGED BATCH: borra la inscripción de origen e inserta la de destino, en las
        // dos tablas (por_alumno y por_comision). O se aplica todo o nada; nunca queda "en dos comisiones".
        await ctx.cass.aplicarInscripciones({
          borrar: [{ alumno_id, comision_id: comision_origen, materia_id: d.materia_id, fecha_inscripcion: d.fila_origen.fecha_inscripcion }],
          insertar: [{ alumno_id, comision_id: comision_destino, materia_id: d.materia_id, docente_id: d.docente_destino, cuatrimestre_id: d.cuatrimestre_id, fecha_inscripcion: d.fecha_nueva }],
        });
        return {};
      },
      // COMPENSACIÓN = el batch inverso: borra el destino y restaura el origen con los datos
      // guardados en `fila_origen`. Es idempotente (borrar lo inexistente / reescribir la misma clave).
      compensar: (ctx, d, { alumno_id, comision_origen, comision_destino }) =>
        ctx.cass.aplicarInscripciones({
          borrar: [{ alumno_id, comision_id: comision_destino, materia_id: d.materia_id, fecha_inscripcion: d.fecha_nueva }],
          insertar: [{ alumno_id, comision_id: comision_origen, materia_id: d.materia_id, docente_id: d.fila_origen.docente_id, cuatrimestre_id: d.cuatrimestre_id, fecha_inscripcion: d.fila_origen.fecha_inscripcion, en_revision: d.fila_origen.en_revision }],
        }),
    },
  ],
  resultado: (d, { alumno_id, comision_origen, comision_destino }) => ({ alumno_id, comision_origen, comision_destino, materia_id: d.materia_id }),
};

export const p3CambiarComision = (ctx, input, opts) => ejecutarSaga(ctx, p3Def, input, opts);