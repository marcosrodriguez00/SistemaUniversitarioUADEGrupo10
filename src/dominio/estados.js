// REGLAS DE DOMINIO PURAS: no acceden a ninguna base de datos. Reciben filas, devuelven estados.
// Por eso no participan de sagas ni de compensaciones: son solo cálculo, y se testean sin infraestructura.
// Supuestos a confirmar con el grupo / profesor:
//   - nota de aprobación = 4
//   - parcial >= 4 -> 'regular'; parcial < 4 -> 'libre'
//   - final   >= 4 -> 'aprobada'; final   < 4 (aplazo) -> 'regular' (la materia sigue regular)
export const NOTA_APROBACION = 4;

export const estadoParcial = (nota) => (nota >= NOTA_APROBACION ? 'regular' : 'libre');
export const estadoFinal = (nota) => (nota >= NOTA_APROBACION ? 'aprobada' : 'regular');
// P4 la usa para calcular el campo `estado` que se guarda en Cassandra junto a cada nota.
export const estadoSegunTipo = (tipo, nota) => (tipo === 'final' ? estadoFinal(nota) : estadoParcial(nota));

const ts = (f) => new Date(f).getTime(); // fecha -> número, para poder ordenar

// Convierte las filas de calificaciones_por_alumno de UN alumno (una sola partición de
// Cassandra) en un Map: materia_id -> { estado, ... }. Lo usan P2, P4, P5, P6 y P7.
//  - 'aprobada' si alguna cursada tiene un final aprobado (una vez aprobada, siempre aprobada).
//  - si no, el estado de la fila más reciente de la cursada más reciente (regular | libre).
// Cada cursada se distingue por comision_id: una recursada no se mezcla con el intento anterior.
export function estadoPorMateria(filas) {
  const porMateria = new Map();
  // Se ordena por fecha para procesar la historia en orden cronológico.
  const ordenadas = [...filas].sort((a, b) => ts(a.fecha_evaluacion) - ts(b.fecha_evaluacion));
  for (const f of ordenadas) {
    let m = porMateria.get(f.materia_id);
    if (!m) {
      m = { estado: null, comision_id: null, aprobada_en: null, aprobada_comision: null, cursadas: new Map() };
      porMateria.set(f.materia_id, m);
    }
    m.cursadas.set(f.comision_id, f.estado); // último estado conocido de cada cursada
    m.comision_id = f.comision_id;           // al terminar el bucle: la cursada más reciente
    if (f.estado === 'aprobada' && !m.aprobada_en) {
      m.aprobada_en = new Date(f.fecha_evaluacion);
      m.aprobada_comision = f.comision_id;
    }
  }
  // Estado final: aprobada gana siempre; si no, el de la cursada más reciente.
  for (const m of porMateria.values()) {
    m.estado = m.aprobada_en ? 'aprobada' : m.cursadas.get(m.comision_id);
  }
  return porMateria;
}

// Ids de las materias que están en cierto estado (ej. todas las 'aprobada'). Lo usa P7.
export const materiasConEstado = (estados, estado) =>
  [...estados].filter(([, e]) => e.estado === estado).map(([id]) => id);

// ¿El alumno cumple este prerrequisito? Cada correlativa de Neo4j trae un `tipo`:
//   'aprobada'     exige tener la materia aprobada
//   'regularizada' acepta regular O aprobada (aprobada también "habilita" más que regular)
export function cumpleRequisito(req, estados) {
  const st = estados.get(req.requiere)?.estado;
  if (req.tipo === 'aprobada') return st === 'aprobada';
  return st === 'aprobada' || st === 'regular';
}

// Promedio redondeado a 2 decimales (lo usa P6, trayectoria). null si no hay notas.
export const promedio = (nums) =>
  nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;