/** saga_log: una fila por operación. Es lo que hace posible la idempotencia y la recuperación. */
export function crearLogMongo(db) {
  const col = db.collection('saga_log');
  const ahora = () => new Date();
  return {
    // Crea la operación SOLO si no existe ($setOnInsert). Si ya existía (reintento con el
    // mismo operacion_id), devuelve la que está guardada con su estado y sus pasos.
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
    // $addToSet: si se repite el paso, no se duplica en el array (también idempotente).
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