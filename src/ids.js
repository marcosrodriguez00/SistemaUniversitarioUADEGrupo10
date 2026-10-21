// IDENTIFICADORES COMPARTIDOS ENTRE MOTORES
// No existe una transacción que abarque Mongo, Redis, Neo4j y Cassandra. Lo único que une
// un mismo objeto de negocio (un alumno, una comisión) entre los motores es que todos
// lo nombren con el MISMO identificador. Por eso los genera la aplicación, nunca el motor.
import { randomUUID } from 'node:crypto';

// ID de cada saga. Se genera UNA sola vez al empezar y se guarda en el saga_log.
// Si la operación se reintenta con el mismo ID, el sistema reconoce que ya existe y no
// duplica nada (idempotencia). UUID: dos procesos en paralelo nunca generan el mismo.
export const nuevaOperacion = () => `OP-${randomUUID()}`;

// IDs de las entidades que carga el seed: legibles y reproducibles
// (idAlumno(123) siempre es 'A000123'), cómodos para mostrar en la defensa oral.
export const idAlumno = (n) => `A${String(n).padStart(6, '0')}`;
export const idMateria = (n) => `MAT-${String(n).padStart(3, '0')}`;
export const idComision = (materia_id, cuatrimestre_id, n) =>
  `COM-${materia_id.slice(4)}-${cuatrimestre_id}-${n}`;
export const idMesa = (materia_id, fecha) => `MESA-${materia_id.slice(4)}-${fecha}`;
export const idDocente = (n) => `D${String(n).padStart(4, '0')}`;
export const idPlan = (sufijo) => `PLAN-${sufijo}`;

// Claves de Redis para el cupo. Por cada comisión (o mesa) hay DOS claves:
//   cupo:...      contador de lugares disponibles
//   reservas:...  set con los alumnos que ya tienen lugar (es lo que hace idempotente
//                 tanto la reserva como su compensación)
// ns = 'comision' | 'mesa', así el mismo código sirve para P2/P3 y P5.
export const claveCupo = (ns, id) => `cupo:${ns}:${id}`;
export const claveReservas = (ns, id) => `reservas:${ns}:${id}`;