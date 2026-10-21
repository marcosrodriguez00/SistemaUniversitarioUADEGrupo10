import { ErrorSimulado } from './errores.js';

// FALLAS A PROPÓSITO para la demo de la defensa (--fail-at). Así mostramos la compensación
// sin tener que romper nada de verdad. ctx.failAt puede ser:
//   "<paso>"        falla DESPUÉS de ejecutar ese paso (ya escribió, hay algo que compensar)
//   "<paso>:antes"  falla ANTES de ejecutarlo (no escribió nada)
//   "<punto>"       puntos internos que algunos pasos declaran (ej. "correlatividad-medio"),
//                   para simular una falla A MITAD de un paso
export function conFailpoints(ctx, failAt = null) {
  ctx.failAt = failAt;

  // Los pasos y el runner llaman a ctx.failpoint('nombre'). Si coincide con failAt, explota.
  ctx.failpoint = (nombre) => {
    if (ctx.failAt && ctx.failAt === nombre) {
      ctx.failAt = null;          // UN SOLO USO: se limpia al disparar, así el reintento
      throw new ErrorSimulado(nombre); // con el mismo operacion_id funciona (demuestra idempotencia)
    }
  };
  return ctx;
}