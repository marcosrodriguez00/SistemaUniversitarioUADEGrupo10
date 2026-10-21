import { ErrorNegocio } from './errores.js';
import { nuevaOperacion } from '../ids.js';

// RUNNER DE SAGAS: la pieza que reemplaza a la transacción que no existe entre motores.
// Una saga se define como una lista de pasos, y cada paso tiene:
//   accion(ctx, datos, input)    lo que escribe o lee
//   compensar(ctx, datos, input) cómo se deshace (opcional: los pasos de solo lectura no la tienen)
//
// Las cuatro garantías que da el runner (lo que pide la sección 5 de la consigna):
//  1. ORDEN: los pasos corren en el orden definido.
//  2. REGISTRO: cada paso se anota en saga_log ANTES de ejecutarse (pasos_iniciados) y DESPUÉS
//     (pasos_completados). Si el proceso se cae, el log dice qué pudo haberse escrito.
//  3. ROLLBACK: ante un fallo se compensan, en orden inverso, todos los pasos iniciados
//     (incluido el que falló, porque pudo haber escrito algo antes de fallar).
//  4. IDEMPOTENCIA: reintentar con el mismo operacion_id no duplica.
export async function ejecutarSaga(ctx, def, input, { operacion_id = nuevaOperacion() } = {}) {
  const out = (extra) => ({ operacion_id, saga: def.nombre, ...extra });

  // Crea el registro de la operación, o devuelve el que ya existía si es un reintento.
  const op = await ctx.log.iniciar({ operacion_id, saga: def.nombre, input });

  // IDEMPOTENCIA: si la operación ya terminó, no se ejecuta de nuevo; se devuelve lo mismo.
  if (op.estado === 'COMPLETADA') return out({ ok: true, estado: 'COMPLETADA', resultado: op.resultado, repetida: true });
  if (op.estado === 'COMPENSADA' || op.estado === 'RECHAZADA') {
    return out({ ok: false, estado: op.estado, error: op.error, repetida: true });
  }
  // La operación falló antes y alguna compensación no pudo completarse: se reintenta compensar.
  if (op.estado === 'COMPENSACION_FALLIDA') {
    return out(await abortar(ctx, def, op, op.datos ?? {}, new Error(op.error?.mensaje ?? 'compensación pendiente')));
  }

  // Si la operación quedó EN_CURSO (reintento), retoma con los datos ya guardados y
  // se saltea los pasos que ya se completaron.
  const inputGuardado = op.input ?? input;
  const datos = { ...(op.datos ?? {}) };
  const hechos = new Set(op.pasos_completados ?? []);

  try {
    for (const paso of def.pasos) {
      if (hechos.has(paso.nombre)) continue;

      ctx.failpoint(`${paso.nombre}:antes`);                 // falla de demo ANTES del paso
      await ctx.log.iniciarPaso(operacion_id, paso.nombre);  // anota la INTENCIÓN antes de escribir
      const nuevos = await paso.accion(ctx, datos, inputGuardado);
      Object.assign(datos, nuevos ?? {});                    // lo que el paso produjo lo ven los siguientes
      await ctx.log.completarPaso(operacion_id, paso.nombre, datos); // anota que terminó, con sus datos
      ctx.failpoint(paso.nombre);                            // falla de demo DESPUÉS del paso
    }

    // Todos los pasos salieron bien: se confirma la operación. Este es el "commit" de la saga.
    const resultado = def.resultado ? def.resultado(datos, inputGuardado) : datos;
    await ctx.log.completar(operacion_id, resultado);
    return out({ ok: true, estado: 'COMPLETADA', resultado });
  } catch (error) {
    // Algo falló: se vuelve a leer el log (tiene los pasos iniciados) y se deshace.
    const actual = await ctx.log.get(operacion_id);
    return out(await abortar(ctx, def, actual, datos, error));
  }
}

// ROLLBACK: recorre los pasos al revés y ejecuta la compensación de cada paso INICIADO.
// Compensa también el paso que falló: pudo escribir a medias, y como las compensaciones
// son idempotentes, compensar algo que no llegó a escribir es inofensivo.
async function abortar(ctx, def, op, datos, error) {
  const operacion_id = op.operacion_id ?? op._id;
  const iniciados = new Set(op.pasos_iniciados ?? []);
  const fallidas = [];

  for (const paso of [...def.pasos].reverse()) {
    if (!iniciados.has(paso.nombre) || !paso.compensar) continue;
    try {
      await paso.compensar(ctx, datos, op.input);
      await ctx.log.registrarCompensacion(operacion_id, paso.nombre); // queda como evidencia
    } catch (e) {
      // Una compensación puede fallar (ej. el motor está caído). Se sigue con las demás
      // y se anota: la operación queda COMPENSACION_FALLIDA para reintentarla después.
      fallidas.push({ paso: paso.nombre, error: e.message });
    }
  }

  const info = { mensaje: error.message, codigo: error.codigo ?? error.name, detalle: error.detalle ?? null };
  // Estado final según qué pasó:
  //   alguna compensación falló -> COMPENSACION_FALLIDA | regla de negocio -> RECHAZADA | falla técnica -> COMPENSADA
  const estado = fallidas.length ? 'COMPENSACION_FALLIDA' : error instanceof ErrorNegocio ? 'RECHAZADA' : 'COMPENSADA';
  await ctx.log.setEstado(operacion_id, estado, { error: info, compensaciones_fallidas: fallidas });
  return { ok: false, estado, error: info, compensaciones_fallidas: fallidas };
}

// RECUPERACIÓN tras una caída del proceso: busca las sagas que quedaron EN_CURSO (o con
// compensación fallida) y deshace lo que el log dice que se alcanzó a escribir.
// Es la respuesta a "¿qué pasa si el proceso se cae a mitad de una operación?"
export async function recuperar(ctx, defs, { antiguedadMs = 60_000 } = {}) {
  const pendientes = await ctx.log.listarPendientes(antiguedadMs);
  const resultados = [];
  for (const op of pendientes) {
    const def = defs[op.saga];
    if (!def) {
      resultados.push({ operacion_id: op._id, saga: op.saga, estado: 'SAGA_DESCONOCIDA' });
      continue;
    }
    const r = await abortar(ctx, def, op, op.datos ?? {}, new Error('Recuperación tras caída'));
    resultados.push({ operacion_id: op._id, saga: op.saga, estado: r.estado });
  }
  return resultados;
}