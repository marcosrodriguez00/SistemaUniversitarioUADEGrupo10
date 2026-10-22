import { connect } from '../db/mongo.js';

// MONGO: colecciones (el _id de cada una es el ID de negocio, por eso no necesita índice extra):
//   planes      {_id: plan_id, nombre, carrera_id, materias:[materia_id], estado}
//   materias    {_id: materia_id, codigo, nombre, creditos, comisiones:[{comision_id, cuatrimestre_id, cupo_maximo, ...}]}
//   docentes    {_id: docente_id, ...}
//   estudiantes {_id: alumno_id, numero_legajo, planes:[{plan_id, carrera_id}], ...}
//   mesas       {_id: mesa_id, materia_id, fecha, aula, cupo_maximo}
//   saga_log    {_id: operacion_id, saga, estado, pasos_iniciados, pasos_completados, datos, ...}
// Mongo crea las colecciones solo al insertar el primer documento: acá solo hacen falta índices.
export async function initMongo() {
  const db = await connect();
  // Únicos: evitan legajos, códigos de materia o documentos duplicados.
  await db.collection('estudiantes').createIndex({ numero_legajo: 1 }, { unique: true });
  await db.collection('materias').createIndex({ codigo: 1 }, { unique: true });
  // Búsqueda de una comisión embebida (la usa getComision en P2, P3 y P5).
  await db.collection('materias').createIndex({ 'comisiones.comision_id': 1 });
  await db.collection('docentes').createIndex({ numero_documento: 1 }, { unique: true });
  await db.collection('mesas').createIndex({ materia_id: 1, fecha: 1 });
  // Para recuperar(): encuentra rápido las sagas incompletas tras una caída.
  await db.collection('saga_log').createIndex({ estado: 1, actualizado_en: 1 });
  console.log('✔ Mongo: índices listos');
}