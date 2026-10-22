// MONGODB: catálogo (planes, materias con sus comisiones embebidas, estudiantes, mesas) y
// saga_log (registro de pasos de cada operación). El archivo tiene DOS funciones:
//   crearMongoRepo  → catálogo, lo usan los problemas y el menú interactivo
//   crearLogMongo   → saga_log, lo usa el runner de sagas

// Convierte lo que escribe el usuario en un filtro de Mongo: cada palabra debe aparecer
// (sin distinguir mayúsculas ni tildes) en alguno de los campos indicados.
// Lo usan las búsquedas del menú interactivo (buscarEstudiantes, buscarMaterias).
const CLASES = { a: 'aáàä', e: 'eéèë', i: 'iíìï', o: 'oóòö', u: 'uúùü', n: 'nñ' };
const patron = (palabra) => palabra.normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')                                             // escapa símbolos de regex
  .replace(/[aeioun]/gi, (ch) => `[${CLASES[ch.toLowerCase()]}]`);                    // 'a' → [aáàä]
const filtroTexto = (texto, campos) => ({
  $and: texto.trim().split(/\s+/).map((p) => ({ $or: campos.map((campo) => ({ [campo]: new RegExp(patron(p), 'i') })) })),
});

// ============================================================================
// CATÁLOGO
// ============================================================================
export function crearMongoRepo(db) {
  const c = (n) => db.collection(n); // atajo: c('materias') = db.collection('materias')
  return {
    // Busca una comisión dentro del arreglo `comisiones` embebido en la materia.
    // `$elemMatch` en la proyección devuelve SOLO esa comisión, no las ~225 de la materia.
    // Se apoya en el índice sobre 'comisiones.comision_id' (ver init-mongo.js).
    async getComision(comision_id) {
      const m = await c('materias').findOne(
        { 'comisiones.comision_id': comision_id },
        { projection: { materia_id: 1, comisiones: { $elemMatch: { comision_id } } } },
      );
      if (!m) return null;
      return { ...m.comisiones[0], materia_id: m.materia_id ?? m._id };
    },
    // Lecturas por _id (que es el id de negocio): no necesitan índice extra.
    getEstudiante: (alumno_id) => c('estudiantes').findOne({ _id: alumno_id }),
    getPlan: (plan_id) => c('planes').findOne({ _id: plan_id }),
    getMesa: (mesa_id) => c('mesas').findOne({ _id: mesa_id }),
    // Varias materias por lista de ids, sin traer sus comisiones (más liviano). Lo usa P7a.
    getMaterias: (ids) => c('materias').find({ _id: { $in: ids } }, { projection: { comisiones: 0 } }).toArray(),

    // P1, paso 'guardar-plan': inserta las materias que no existan.
    // `$setOnInsert` solo escribe si el documento es NUEVO: no pisa las que ya están
    // (una materia puede pertenecer a varios planes). Por eso es idempotente.
    async upsertMaterias(materias) {
      if (!materias.length) return;
      await c('materias').bulkWrite(materias.map((m) => ({
        updateOne: {
          filter: { _id: m.materia_id },
          update: { $setOnInsert: { materia_id: m.materia_id, codigo: m.codigo, nombre: m.nombre, creditos: m.creditos ?? 6, comisiones: [] } },
          upsert: true,
        },
      })));
    },
    // P1, paso 'guardar-plan': alta o actualización idempotente del plan.
    // SIEMPRE queda 'pendiente_habilitacion': solo el paso 'habilitar' lo deja usable.
    async upsertPlan({ plan_id, nombre, carrera_id, materias }) {
      await c('planes').updateOne(
        { _id: plan_id },
        { $set: { plan_id, nombre, carrera_id, materias, estado: 'pendiente_habilitacion' } },
        { upsert: true },
      );
    },

    // ---- BÚSQUEDAS PARA EL MENÚ INTERACTIVO (solo lectura). Cada palabra escrita debe
    // aparecer en alguno de los campos; ignoran mayúsculas y tildes.
    buscarEstudiantes: (texto, limite = 10) =>
      c('estudiantes').find(filtroTexto(texto, ['nombre', 'apellido', '_id'])).limit(limite).toArray(),
    buscarMaterias: (texto, limite = 10) =>
      c('materias').find(filtroTexto(texto, ['nombre', 'codigo', '_id']), { projection: { comisiones: 0 } }).limit(limite).toArray(),
    // Comisiones de una materia en un cuatrimestre (están embebidas en la materia).
    async comisionesDeMateria(materia_id, cuatrimestre_id) {
      const m = await c('materias').findOne({ _id: materia_id }, { projection: { comisiones: 1 } });
      return (m?.comisiones ?? []).filter((x) => x.cuatrimestre_id === cuatrimestre_id);
    },
    mesasDeMateria: (materia_id) => c('mesas').find({ materia_id }).sort({ fecha: 1 }).toArray(),

    // P1, paso 'habilitar' y su compensación (vuelve a 'pendiente_habilitacion').
    setPlanEstado: (plan_id, estado) => c('planes').updateOne({ _id: plan_id }, { $set: { estado } }),
  };
}

// ============================================================================
// SAGA_LOG: una fila por operación. Es lo que hace posible la idempotencia y la recuperación.
// ============================================================================
export function crearLogMongo(db) {
  const col = db.collection('saga_log');
  const ahora = () => new Date();
  return {
    // Crea la operación SOLO si no existe ($setOnInsert). Si ya existía (reintento con el
    // mismo operacion_id), devuelve la que está guardada, con su estado y sus pasos.
    // Por eso _id = operacion_id: Mongo garantiza que no hay dos con el mismo _id.
    async iniciar({ operacion_id, saga, input }) {
      return col.findOneAndUpdate(
        { _id: operacion_id },
        {
          $setOnInsert: {
            operacion_id, saga, input, estado: 'EN_CURSO', datos: {},
            pasos_iniciados: [], pasos_completados: [], compensaciones: [],
            creado_en: ahora(), actualizado_en: ahora(),
          },
        },
        { upsert: true, returnDocument: 'after' },
      );
    },
    get: (operacion_id) => col.findOne({ _id: operacion_id }),

    // WRITE-AHEAD: se anota la intención ANTES de escribir en el motor.
    // `$addToSet`: si el paso se repite, no se duplica en el arreglo (también idempotente).
    iniciarPaso: (id, paso) =>
      col.updateOne({ _id: id }, { $addToSet: { pasos_iniciados: paso }, $set: { actualizado_en: ahora() } }),

    // Se anota que el paso terminó y se guardan los datos acumulados. Si hay que reanudar,
    // los pasos siguientes los reciben de acá.
    completarPaso: (id, paso, datos) =>
      col.updateOne({ _id: id }, { $addToSet: { pasos_completados: paso }, $set: { datos, actualizado_en: ahora() } }),

    // Evidencia de qué compensaciones se ejecutaron (útil para mostrar en la defensa).
    registrarCompensacion: (id, paso) =>
      col.updateOne({ _id: id }, { $addToSet: { compensaciones: paso }, $set: { actualizado_en: ahora() } }),

    // El "commit" de la saga: pasa a COMPLETADA y guarda el resultado.
    completar: (id, resultado) =>
      col.updateOne({ _id: id }, { $set: { estado: 'COMPLETADA', resultado, actualizado_en: ahora() } }),

    // Estados finales de falla: RECHAZADA, COMPENSADA o COMPENSACION_FALLIDA.
    setEstado: (id, estado, extra = {}) =>
      col.updateOne({ _id: id }, { $set: { estado, ...extra, actualizado_en: ahora() } }),

    // Para recuperar(): sagas EN_CURSO (o con compensación fallida) sin movimiento hace un rato.
    // La antigüedad evita "recuperar" una operación que todavía está corriendo normalmente.
    listarPendientes: (antiguedadMs) =>
      col.find({
        estado: { $in: ['EN_CURSO', 'COMPENSACION_FALLIDA'] },
        actualizado_en: { $lte: new Date(Date.now() - antiguedadMs) },
      }).toArray(),
  };
}