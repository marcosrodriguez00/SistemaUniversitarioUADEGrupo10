import { ErrorNegocio } from '../saga/errores.js';
import { estadoSegunTipo } from '../dominio/estados.js';

// PROBLEMA 4 — CARGA DE CALIFICACIONES. Motor: solo Cassandra. NO USA SAGA.
//   input: { docente_id, tipo: 'parcial'|'final', comision_id (parcial) | mesa_id (final),
//            notas: [{ alumno_id, nota }], fecha_evaluacion? }
// Por qué sin saga: no hay varios motores que mantener coherentes y cada fila es una escritura
// atómica e idempotente (mismo PK = upsert). Si algo falla, se REINTENTA el lote completo
// (recuperación hacia adelante); no hace falta compensar.
// IDEMPOTENCIA: para recargar el mismo lote sin duplicar hay que pasar la MISMA
// fecha_evaluacion, porque forma parte de la clave primaria.
// El estado de la materia (regular/aprobada/libre) se calcula y se guarda junto a la nota.
export async function p4CargarCalificaciones(ctx, { docente_id, tipo, comision_id, mesa_id, notas, fecha_evaluacion }) {
  if (!['parcial', 'final'].includes(tipo)) throw new ErrorNegocio('TIPO_INVALIDO', 'tipo debe ser parcial o final');
  // Una sola fecha para TODO el lote (y fija si el llamador la pasa: reintento idempotente).
  const fecha = fecha_evaluacion ? new Date(fecha_evaluacion) : new Date();
  const filas = [];      // notas válidas, listas para escribir
  const rechazadas = []; // notas inválidas: NO se escriben y se informan al docente

  if (tipo === 'parcial') {
    if (!comision_id) throw new ErrorNegocio('FALTA_COMISION', 'Un parcial se carga sobre una comisión');
    // UNA lectura de la partición de la comisión; se arma un Map para buscar rápido por alumno.
    const inscriptos = new Map((await ctx.cass.inscripcionesComision(comision_id)).map((r) => [r.alumno_id, r]));
    for (const { alumno_id, nota } of notas) {
      const insc = inscriptos.get(alumno_id);
      // VALIDAR ANTES DE ESCRIBIR: lo inválido no entra al lote. Así el único fallo posible
      // durante la escritura es técnico (motor caído), y ese se resuelve reintentando.
      if (!insc) { rechazadas.push({ alumno_id, motivo: 'NO_INSCRIPTO_EN_COMISION' }); continue; }
      if (!(nota >= 0 && nota <= 10)) { rechazadas.push({ alumno_id, motivo: 'NOTA_FUERA_DE_RANGO' }); continue; }
      filas.push({ alumno_id, fecha_evaluacion: fecha, materia_id: insc.materia_id, comision_id, mesa_id: null, docente_id, tipo, nota, estado: estadoSegunTipo(tipo, nota) });
    }
  } else {
    if (!mesa_id) throw new ErrorNegocio('FALTA_MESA', 'Un final se carga sobre una mesa');
    const inscriptos = new Map((await ctx.cass.inscripcionesMesaMesa(mesa_id)).map((r) => [r.alumno_id, r]));
    for (const { alumno_id, nota } of notas) {
      const insc = inscriptos.get(alumno_id);
      if (!insc) { rechazadas.push({ alumno_id, motivo: 'NO_INSCRIPTO_EN_MESA' }); continue; }
      if (!(nota >= 0 && nota <= 10)) { rechazadas.push({ alumno_id, motivo: 'NOTA_FUERA_DE_RANGO' }); continue; }
      // El final cierra la cursada MÁS RECIENTE de esa materia. Su comision_id va en la fila
      // (es parte de la clave): así una recursada nunca pisa el intento anterior.
      const cursadas = (await ctx.cass.inscripcionesAlumno(alumno_id)).filter((i) => i.materia_id === insc.materia_id);
      const ultima = cursadas.sort((a, b) => new Date(a.fecha_inscripcion) - new Date(b.fecha_inscripcion)).at(-1);
      if (!ultima) { rechazadas.push({ alumno_id, motivo: 'SIN_CURSADA_PREVIA' }); continue; }
      filas.push({ alumno_id, fecha_evaluacion: fecha, materia_id: insc.materia_id, comision_id: ultima.comision_id, mesa_id, docente_id, tipo, nota, estado: estadoSegunTipo(tipo, nota) });
    }
  }
  // ÚNICA ESCRITURA: todas las notas válidas, en concurrencia. Si el motor falla acá, se
  // vuelve a llamar con la misma fecha_evaluacion: las filas ya guardadas se reescriben igual.
  await ctx.cass.insertarCalificaciones(filas);
  return { cargadas: filas.length, rechazadas, estados: Object.fromEntries(filas.map((f) => [f.alumno_id, f.estado])) };
}