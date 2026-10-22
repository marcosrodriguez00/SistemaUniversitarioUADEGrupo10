import cassandra from 'cassandra-driver';
import { KEYSPACE } from '../config.js';

// CASSANDRA: una tabla por consulta. TODA consulta lleva la partition key completa
// (alumno_id, comision_id o mesa_id): no se usa ALLOW FILTERING ni índices secundarios.
// Lo que no entra en la clave se filtra en Node sobre UNA partición (acotada).

const T = (n) => `${KEYSPACE}.${n}`;      // nombre completo de tabla: universidad.<tabla>
const OPT = { prepare: true };            // sentencias preparadas: más rápidas y seguras
const d = (f) => (f instanceof Date ? f : new Date(f)); // el driver exige Date para columnas timestamp

export function crearCassandraRepo(client) {
  // Ejecuta un SELECT y devuelve las filas como objetos simples.
  const select = async (cql, params) => (await client.execute(cql, params, OPT)).rows.map((r) => ({ ...r }));

  // CQL reutilizado por las sagas. Cada inscripción se escribe en DOS tablas (denormalización):
  // una para consultar por alumno y otra por comisión.
  const sqlInsAlumno = `INSERT INTO ${T('inscripciones_por_alumno')} (alumno_id, fecha_inscripcion, materia_id, comision_id, docente_id, cuatrimestre_id, en_revision) VALUES (?,?,?,?,?,?,?)`;
  const sqlInsCom = `INSERT INTO ${T('inscripciones_por_comision')} (comision_id, fecha_inscripcion, alumno_id, materia_id, docente_id, cuatrimestre_id) VALUES (?,?,?,?,?,?)`;
  const sqlDelAlumno = `DELETE FROM ${T('inscripciones_por_alumno')} WHERE alumno_id=? AND fecha_inscripcion=? AND materia_id=? AND comision_id=?`;
  const sqlDelCom = `DELETE FROM ${T('inscripciones_por_comision')} WHERE comision_id=? AND fecha_inscripcion=? AND alumno_id=?`;
  const sqlCalif = `INSERT INTO ${T('calificaciones_por_alumno')} (alumno_id, fecha_evaluacion, materia_id, comision_id, mesa_id, docente_id, tipo, nota, estado) VALUES (?,?,?,?,?,?,?,?,?)`;

  return {
    // ---- LECTURAS: cada una consulta UNA partición.
    trayectoria: (alumno_id) => select(`SELECT * FROM ${T('calificaciones_por_alumno')} WHERE alumno_id = ?`, [alumno_id]),
    inscripcionesAlumno: (alumno_id) => select(`SELECT * FROM ${T('inscripciones_por_alumno')} WHERE alumno_id = ?`, [alumno_id]),
    inscripcionesComision: (comision_id) => select(`SELECT * FROM ${T('inscripciones_por_comision')} WHERE comision_id = ?`, [comision_id]),
    inscripcionesMesaAlumno: (alumno_id) => select(`SELECT * FROM ${T('inscripciones_mesa_por_alumno')} WHERE alumno_id = ?`, [alumno_id]),
    inscripcionesMesaMesa: (mesa_id) => select(`SELECT * FROM ${T('inscripciones_mesa_por_mesa')} WHERE mesa_id = ?`, [mesa_id]),

    // ---- P2 / P3: LOGGED BATCH sobre las dos tablas de inscripción (todo o nada).
    // Reescribir la misma clave es un UPSERT, por eso reintentar no duplica (idempotencia).
    // `borrar` e `insertar` en un mismo batch permite que P3 mueva una inscripción atómicamente.
    async aplicarInscripciones({ insertar = [], borrar = [] }) {
      const qs = [];
      for (const r of borrar) {
        qs.push({ query: sqlDelAlumno, params: [r.alumno_id, d(r.fecha_inscripcion), r.materia_id, r.comision_id] });
        qs.push({ query: sqlDelCom, params: [r.comision_id, d(r.fecha_inscripcion), r.alumno_id] });
      }
      for (const r of insertar) {
        qs.push({ query: sqlInsAlumno, params: [r.alumno_id, d(r.fecha_inscripcion), r.materia_id, r.comision_id, r.docente_id ?? null, r.cuatrimestre_id ?? null, r.en_revision ?? false] });
        qs.push({ query: sqlInsCom, params: [r.comision_id, d(r.fecha_inscripcion), r.alumno_id, r.materia_id, r.docente_id ?? null, r.cuatrimestre_id ?? null] });
      }
      if (qs.length) await client.batch(qs, { prepare: true, logged: true });
    },

    // ---- P5: igual que arriba pero para las dos tablas de inscripción a mesa.
    async aplicarInscripcionesMesa({ insertar = [], borrar = [] }) {
      const qs = [];
      for (const r of borrar) {
        qs.push({ query: `DELETE FROM ${T('inscripciones_mesa_por_alumno')} WHERE alumno_id=? AND fecha_mesa=? AND materia_id=? AND mesa_id=?`, params: [r.alumno_id, d(r.fecha_mesa), r.materia_id, r.mesa_id] });
        qs.push({ query: `DELETE FROM ${T('inscripciones_mesa_por_mesa')} WHERE mesa_id=? AND alumno_id=?`, params: [r.mesa_id, r.alumno_id] });
      }
      for (const r of insertar) {
        qs.push({ query: `INSERT INTO ${T('inscripciones_mesa_por_alumno')} (alumno_id, fecha_mesa, materia_id, mesa_id) VALUES (?,?,?,?)`, params: [r.alumno_id, d(r.fecha_mesa), r.materia_id, r.mesa_id] });
        qs.push({ query: `INSERT INTO ${T('inscripciones_mesa_por_mesa')} (mesa_id, alumno_id, materia_id) VALUES (?,?,?)`, params: [r.mesa_id, r.alumno_id, r.materia_id] });
      }
      if (qs.length) await client.batch(qs, { prepare: true, logged: true });
    },

    // ---- P4: carga de notas. Sin batch: son filas de muchas particiones distintas, y un batch
    // multi-partición es lento. executeConcurrent las manda en paralelo (64 a la vez).
    // Cada fila es un upsert: reintentar el lote es seguro.
    async insertarCalificaciones(filas) {
      const queries = filas.map((f) => ({
        query: sqlCalif,
        params: [f.alumno_id, d(f.fecha_evaluacion), f.materia_id, f.comision_id, f.mesa_id ?? null, f.docente_id ?? null, f.tipo, f.nota, f.estado],
      }));
      if (queries.length) await cassandra.concurrent.executeConcurrent(client, queries, { concurrencyLevel: 64 });
    },

    // ---- P8: lectura y corrección de una nota puntual (clave primaria completa).
    async getCalificacion({ alumno_id, fecha_evaluacion, materia_id, comision_id }) {
      const r = await select(
        `SELECT * FROM ${T('calificaciones_por_alumno')} WHERE alumno_id=? AND fecha_evaluacion=? AND materia_id=? AND comision_id=?`,
        [alumno_id, d(fecha_evaluacion), materia_id, comision_id],
      );
      return r[0] ?? null;
    },
    // `IF EXISTS`: si la fila no existe, NO la crea (evita filas fantasma). Se usa tanto en la
    // acción como en la compensación de P8.
    actualizarCalificacion({ alumno_id, fecha_evaluacion, materia_id, comision_id }, { nota, estado }) {
      return client.execute(
        `UPDATE ${T('calificaciones_por_alumno')} SET nota=?, estado=? WHERE alumno_id=? AND fecha_evaluacion=? AND materia_id=? AND comision_id=? IF EXISTS`,
        [nota, estado, alumno_id, d(fecha_evaluacion), materia_id, comision_id], OPT,
      );
    },
    // P8: marca o desmarca una inscripción como "en revisión". También con IF EXISTS.
    marcarRevision({ alumno_id, fecha_inscripcion, materia_id, comision_id }, valor) {
      return client.execute(
        `UPDATE ${T('inscripciones_por_alumno')} SET en_revision=? WHERE alumno_id=? AND fecha_inscripcion=? AND materia_id=? AND comision_id=? IF EXISTS`,
        [valor, alumno_id, d(fecha_inscripcion), materia_id, comision_id], OPT,
      );
    },

    // ---- Carga masiva (seed): muchas escrituras en paralelo.
    async ejecutarConcurrente(queries, concurrencyLevel = 128) {
      if (queries.length) await cassandra.concurrent.executeConcurrent(client, queries, { concurrencyLevel });
    },
    sql: { insAlumno: sqlInsAlumno, insCom: sqlInsCom, calif: sqlCalif }, // el seed reutiliza estas sentencias
  };
}