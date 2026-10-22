// Punto de entrada de los problemas: reexporta todo para que el CLI importe desde un solo lugar.
export { p1Def, p1CargarPlan } from './p1.js';
export { p2Def, p2Inscribir } from './p2.js';
export { p3Def, p3CambiarComision } from './p3.js';
export { p4CargarCalificaciones } from './p4.js';
export { p5Def, p5InscribirMesa } from './p5.js';
export { p6Trayectoria } from './p6.js';
export { p7PuedoCursar, p7Destraba, p7CadenaMasLarga } from './p7.js';
export { p8Def, p8Rectificar, p8Trazabilidad } from './p8.js';

import { p1Def } from './p1.js';
import { p2Def } from './p2.js';
import { p3Def } from './p3.js';
import { p5Def } from './p5.js';
import { p8Def } from './p8.js';

// REGISTRO DE SAGAS por nombre. Lo usa recuperar(): al leer saga_log necesita saber
// qué definición (pasos y compensaciones) corresponde a cada operación pendiente.
// P4, P6 y P7 no están: no son sagas.
export const SAGAS = Object.fromEntries([p1Def, p2Def, p3Def, p5Def, p8Def].map((d) => [d.nombre, d]));