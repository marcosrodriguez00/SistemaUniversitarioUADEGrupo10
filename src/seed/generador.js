// GENERADOR PURO (sin acceso a motores) y REPRODUCIBLE: misma semilla -> mismos datos.
import { idAlumno, idDocente, idMateria, idComision, idMesa } from '../ids.js';
import { estadoSegunTipo } from '../dominio/estados.js';

export const CUATRIMESTRES_PASADOS = ['2023-1', '2023-2', '2024-1', '2024-2', '2025-1', '2025-2', '2026-1'];
export const CUAT_ACTUAL = '2026-2';      // inscripción abierta ahora
export const CUAT_SIGUIENTE = '2027-1';   // inscripción abierta para el próximo
export const TODOS_CUAT = [...CUATRIMESTRES_PASADOS, CUAT_ACTUAL, CUAT_SIGUIENTE];
export const CUPO_MAXIMO = 45;
export const COMISIONES_POR_CUAT = 25;    // las comisiones 1 a 4 quedan reservadas para los datos de demo

// Generador de números pseudoaleatorios con SEMILLA: la misma semilla da siempre la misma secuencia.
// Es lo que hace reproducible al seed (Math.random() no permite fijar la semilla).
export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];  // elige un elemento al azar
const barajar = (rng, arr) => {                                    // mezcla un arreglo (Fisher-Yates)
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const AREAS = ['Bases de Datos', 'Algoritmos', 'Redes', 'Sistemas Operativos', 'Matemática', 'Ingeniería de Software', 'Arquitectura', 'Estadística', 'Seguridad', 'Inteligencia Artificial'];
const NOMBRES = ['Lucía', 'Mateo', 'Sofía', 'Santiago', 'Valentina', 'Joaquín', 'Camila', 'Tomás', 'Martina', 'Nicolás', 'Julieta', 'Franco'];
const APELLIDOS = ['García', 'Rodríguez', 'López', 'Martínez', 'González', 'Pérez', 'Sánchez', 'Romero', 'Fernández', 'Díaz', 'Álvarez', 'Torres'];

// Correlatividades ACÍCLICAS: las materias se agrupan en semestres y cada una solo requiere
// materias de semestres ANTERIORES, así nunca puede haber un ciclo (A requiere B y B requiere A).
function generarCorrelatividades(rng, ids, porSemestre) {
  const sem = (i) => Math.floor(i / porSemestre);
  const res = [];
  ids.forEach((id, i) => {
    if (sem(i) === 0) return; // las del primer semestre no requieren nada
    const previas = ids.slice(0, i).filter((_, j) => sem(j) < sem(i));
    const inmediatas = previas.filter((_, j) => sem(j) === sem(i) - 1);
    const elegidas = new Set([pick(rng, inmediatas)]);        // siempre una del semestre anterior
    if (rng() < 0.5) elegidas.add(pick(rng, previas));        // y a veces otra más
    for (const requiere of elegidas) res.push({ materia: id, requiere, tipo: rng() < 0.4 ? 'regularizada' : 'aprobada' });
  });
  return res;
}

// CATÁLOGO: 60 materias, 2 planes, 40 docentes, 25 comisiones por materia y cuatrimestre, 2 mesas por materia.
export function generarCatalogo(seed = 42) {
  const rng = mulberry32(seed);
  const materias = Array.from({ length: 60 }, (_, i) => ({
    materia_id: idMateria(i + 1),
    codigo: `ID${String(i + 1).padStart(3, '0')}`,
    nombre: `${AREAS[i % AREAS.length]} ${Math.floor(i / AREAS.length) + 1}`,
    creditos: 4 + (i % 4),
  }));
  const ids = (a, b) => materias.slice(a - 1, b).map((m) => m.materia_id);

  const idsInf = ids(1, 40);
  // El plan de Sistemas comparte las primeras 20 materias con Informática, pero con correlatividades PROPIAS.
  // (Por eso el plan_id vive en la relación REQUIERE de Neo4j y no en el nodo Materia.)
  const idsLsi = [...ids(1, 20), ...ids(41, 50)];
  const planes = [
    { plan_id: 'PLAN-INF', nombre: 'Ingeniería Informática (plan 2020)', carrera_id: 'CAR-INF', materias: idsInf, correlatividades: generarCorrelatividades(rng, idsInf, 4) },
    { plan_id: 'PLAN-LSI', nombre: 'Licenciatura en Sistemas (plan 2021)', carrera_id: 'CAR-LSI', materias: idsLsi, correlatividades: generarCorrelatividades(rng, idsLsi, 3) },
  ];

  const docentes = Array.from({ length: 40 }, (_, i) => ({
    docente_id: idDocente(i + 1),
    numero_documento: String(20000000 + i * 7919),
    nombre: pick(rng, NOMBRES),
    apellido: pick(rng, APELLIDOS),
    email: `docente${i + 1}@uade.edu.ar`,
    especialidades: [AREAS[i % AREAS.length], AREAS[(i + 3) % AREAS.length]],
  }));

  // Comisiones: se EMBEBEN dentro de cada materia en Mongo (materia_id -> lista de comisiones).
  const comisiones = new Map();
  materias.forEach((m, mi) => {
    const lista = [];
    for (const cuat of TODOS_CUAT) {
      for (let n = 1; n <= COMISIONES_POR_CUAT; n++) {
        lista.push({
          comision_id: idComision(m.materia_id, cuat, n),
          cuatrimestre_id: cuat,
          cupo_maximo: CUPO_MAXIMO,
          cupo_minimo: 10,
          horarios: [{ dia: n % 2 ? 'LUN' : 'MAR', desde: '18:00', hasta: '22:00' }, { dia: n % 2 ? 'JUE' : 'VIE', desde: '18:00', hasta: '20:00' }],
          aula: `A${100 + ((mi * 2 + n) % 40)}`,
          docente_ids: [docentes[(mi + n) % docentes.length].docente_id],
        });
      }
    }
    comisiones.set(m.materia_id, lista);
  });

  const mesas = materias.flatMap((m, mi) => ['2026-12-10', '2027-02-17'].map((fecha) => ({
    mesa_id: idMesa(m.materia_id, fecha), materia_id: m.materia_id, fecha, aula: `M${10 + (mi % 20)}`, cupo_maximo: 40,
    docente_id: docentes[mi % docentes.length].docente_id,
  })));

  return { materias, planes, docentes, comisiones, mesas };
}

// ---------- GRAFO EN MEMORIA: espejo de las consultas de Neo4j, solo para generar datos coherentes.
// (El seed no consulta Neo4j mientras genera: lo calcula en JS y recién después carga el grafo real.)
function crearGrafo(plan) {
  const reqs = new Map(plan.materias.map((m) => [m, []]));
  for (const c of plan.correlatividades) reqs.get(c.materia).push(c);
  return reqs;
}
// Materias que un alumno puede cursar dado lo que aprobó y regularizó (misma regla que `cursables` de Neo4j).
export function cursablesJS(grafo, materias, aprobadas, regulares) {
  return materias.filter((m) => {
    if (aprobadas.has(m) || regulares.has(m)) return false;
    return grafo.get(m).every((c) => (c.tipo === 'aprobada' ? aprobadas.has(c.requiere) : aprobadas.has(c.requiere) || regulares.has(c.requiere)));
  });
}
// Todas las materias requeridas, directa o indirectamente, por una materia.
export function ancestros(grafo, materia) {
  const vistos = new Set();
  const visitar = (m) => grafo.get(m).forEach((c) => { if (!vistos.has(c.requiere)) { vistos.add(c.requiere); visitar(c.requiere); } });
  visitar(materia);
  return [...vistos];
}

// Fecha determinística dentro de un cuatrimestre: inicio (10/3 ó 10/8) + N días.
const fechaCuat = (cuat, dias) => {
  const [anio, n] = cuat.split('-');
  const base = new Date(`${anio}-${n === '1' ? '03-10' : '08-10'}T12:00:00Z`);
  return new Date(base.getTime() + dias * 86400000);
};
// Nota aleatoria: con probabilidad pFalla sale desaprobada (0 a 3), si no aprobada (4 a 10).
const nota = (rng, pFalla) => (rng() < pFalla ? Math.floor(rng() * 4) : 4 + Math.floor(rng() * 7));

// ---------- DATOS DE DEMO (determinísticos): ids fijos para la defensa oral
// Elige una materia M con correlativas y define las comisiones, la mesa y los alumnos de demo.
export function elegirDemo(cat) {
  const plan = cat.planes[0];
  const grafo = crearGrafo(plan);
  const M = plan.materias.find((m, i) => i >= 12 && grafo.get(m).some((c) => c.tipo === 'aprobada'));
  const P = grafo.get(M).find((c) => c.tipo === 'aprobada').requiere; // prerrequisito directo (para rectificar en P8)
  return {
    plan_id: plan.plan_id, materia: M, prerrequisito: P, ancestros: ancestros(grafo, M),
    comisiones: {
      // todas en el cuatrimestre actual (un cambio de comisión es dentro del mismo cuatrimestre)
      llena_casi: idComision(M, CUAT_ACTUAL, 1), // 44/45 -> queda 1 lugar (P2 + concurrencia)
      origen: idComision(M, CUAT_ACTUAL, 2),     // donde cursan A-DEMO-11 y A-DEMO-14 (P3)
      vacia: idComision(M, CUAT_ACTUAL, 3),      // destino con cupo (P3)
      completa: idComision(M, CUAT_ACTUAL, 4),   // 45/45 (P3: sin cupo en destino)
    },
    mesa: idMesa(M, '2026-12-10'),
    alumnos: {
      elegible: 'A-DEMO-01', // elegibles A-DEMO-01..10 (para la prueba de concurrencia)
      cambia: 'A-DEMO-11', sin_correlativas: 'A-DEMO-12', para_mesa: 'A-DEMO-13', para_rectificar: 'A-DEMO-14',
    },
  };
}

// Historial de un alumno que aprobó TODAS las materias de la lista (parcial 7 + final 8 en cada una).
function historialAprobado(alumno_id, cat, grafoAncestros, cuat, docentes) {
  const insc = []; const calif = [];
  grafoAncestros.forEach((materia, i) => {
    const comision_id = idComision(materia, cuat, 1);
    const docente_id = cat.comisiones.get(materia)[0].docente_ids[0];
    const f0 = fechaCuat(cuat, i % 5);
    insc.push({ alumno_id, fecha_inscripcion: f0, materia_id: materia, comision_id, docente_id, cuatrimestre_id: cuat });
    calif.push({ alumno_id, fecha_evaluacion: fechaCuat(cuat, 50 + (i % 5)), materia_id: materia, comision_id, mesa_id: null, docente_id, tipo: 'parcial', nota: 7, estado: 'regular' });
    calif.push({ alumno_id, fecha_evaluacion: fechaCuat(cuat, 100 + (i % 5)), materia_id: materia, comision_id, mesa_id: idMesa(materia, `${cuat.slice(0, 4)}-12-10`), docente_id, tipo: 'final', nota: 8, estado: 'aprobada' });
  });
  return { insc, calif };
}

// Arma los alumnos de demo, cada uno preparado para probar un problema concreto.
export function generarDemo(cat, demo) {
  const estudiantes = []; const inscripciones = []; const calificaciones = []; const mesaInsc = [];
  const ocupacion = new Map(); const ocupacionMesa = new Map();
  const ocupar = (com, a) => { if (!ocupacion.has(com)) ocupacion.set(com, new Set()); ocupacion.get(com).add(a); };
  const crearEst = (alumno_id, i, nombre = 'Demo') => estudiantes.push({
    alumno_id, numero_legajo: `LEG-${alumno_id}`, nombre, apellido: String(i).padStart(2, '0'),
    email: `${alumno_id.toLowerCase()}@alumnos.uade.edu.ar`, fecha_nacimiento: '2002-01-01', fecha_ingreso: '2023-03-01',
    planes: [{ plan_id: demo.plan_id, carrera_id: 'CAR-INF' }],
  });
  const grafoLike = demo.ancestros;
  const docM = cat.comisiones.get(demo.materia)[0].docente_ids[0];

  // A-DEMO-01..10, 11, 13 y 14: aprobaron todos los ancestros de M (cumplen las correlativas)
  const conHistorial = [...Array.from({ length: 10 }, (_, i) => `A-DEMO-${String(i + 1).padStart(2, '0')}`), 'A-DEMO-11', 'A-DEMO-13', 'A-DEMO-14'];
  conHistorial.forEach((a, i) => {
    crearEst(a, i + 1);
    const h = historialAprobado(a, cat, grafoLike, '2025-1', cat.docentes);
    inscripciones.push(...h.insc); calificaciones.push(...h.calif);
  });
  crearEst('A-DEMO-12', 12); // sin historial -> P2 la rechaza por correlativas pendientes

  // A-DEMO-11 cursa M en la comisión "origen" (2026-2): es quien cambia de comisión en P3
  inscripciones.push({ alumno_id: 'A-DEMO-11', fecha_inscripcion: new Date('2026-08-12T12:00:00Z'), materia_id: demo.materia, comision_id: demo.comisiones.origen, docente_id: docM, cuatrimestre_id: CUAT_ACTUAL });
  ocupar(demo.comisiones.origen, 'A-DEMO-11');

  // A-DEMO-13: cursó M en 2026-1 y quedó regular (parcial 6): es quien se inscribe a la mesa en P5
  const comM26 = idComision(demo.materia, '2026-1', 1);
  inscripciones.push({ alumno_id: 'A-DEMO-13', fecha_inscripcion: fechaCuat('2026-1', 0), materia_id: demo.materia, comision_id: comM26, docente_id: docM, cuatrimestre_id: '2026-1' });
  calificaciones.push({ alumno_id: 'A-DEMO-13', fecha_evaluacion: fechaCuat('2026-1', 60), materia_id: demo.materia, comision_id: comM26, mesa_id: null, docente_id: docM, tipo: 'parcial', nota: 6, estado: 'regular' });

  // A-DEMO-14: cursa M ahora (inscripción POSTERIOR a la aprobación del prerrequisito).
  // Si en P8 se rectifica el prerrequisito a una nota desaprobada, esta inscripción se marca en_revision.
  inscripciones.push({ alumno_id: 'A-DEMO-14', fecha_inscripcion: new Date('2026-08-14T12:00:00Z'), materia_id: demo.materia, comision_id: demo.comisiones.origen, docente_id: docM, cuatrimestre_id: CUAT_ACTUAL });
  ocupar(demo.comisiones.origen, 'A-DEMO-14');

  // Rellenos: alumnos ficticios que dejan una comisión casi llena (44/45) y otra llena (45/45).
  const relleno = (comision_id, cuantos, prefijo) => {
    for (let i = 1; i <= cuantos; i++) {
      const a = `${prefijo}-${String(i).padStart(2, '0')}`;
      crearEst(a, i, 'Relleno');
      const cuat = comision_id.split('-').slice(2, 4).join('-');
      inscripciones.push({ alumno_id: a, fecha_inscripcion: new Date(`2026-08-0${1 + (i % 8)}T10:00:00Z`), materia_id: demo.materia, comision_id, docente_id: docM, cuatrimestre_id: cuat });
      ocupar(comision_id, a);
    }
  };
  relleno(demo.comisiones.llena_casi, CUPO_MAXIMO - 1, 'A-FILL-A'); // 44/45: queda 1 lugar (prueba de concurrencia)
  relleno(demo.comisiones.completa, CUPO_MAXIMO, 'A-FILL-C');       // 45/45: SIN_CUPO

  // Mesa de demo con 1 lugar libre (39 de 40 inscriptos)
  const mesa = cat.mesas.find((m) => m.mesa_id === demo.mesa);
  for (let i = 1; i <= mesa.cupo_maximo - 1; i++) {
    const a = `A-FILL-M-${String(i).padStart(2, '0')}`;
    crearEst(a, i, 'Relleno');
    mesaInsc.push({ alumno_id: a, fecha_mesa: new Date(`${mesa.fecha}T12:00:00Z`), materia_id: demo.materia, mesa_id: mesa.mesa_id });
    ocupacionMesa.set(mesa.mesa_id, (ocupacionMesa.get(mesa.mesa_id) ?? new Set()).add(a));
  }
  return { estudiantes, inscripciones, calificaciones, mesaInsc, ocupacion, ocupacionMesa };
}

// ---------- ESTUDIANTES MASIVOS: dan el volumen (con 5000 estudiantes salen ~87.000 notas).
// Cada uno cursa materias cuatrimestre a cuatrimestre, SOLO las que sus correlativas le permiten.
export function simularEstudiantes(cat, n, seed = 7) {
  const rng = mulberry32(seed);
  const grafos = new Map(cat.planes.map((p) => [p.plan_id, crearGrafo(p)]));
  const estudiantes = []; const inscripciones = []; const calificaciones = [];
  const ocupacion = new Map();
  const llena = (c) => (ocupacion.get(c)?.size ?? 0) >= CUPO_MAXIMO - 5; // deja margen a las comisiones de demo
  const ocupar = (c, a) => { if (!ocupacion.has(c)) ocupacion.set(c, new Set()); ocupacion.get(c).add(a); };

  for (let i = 1; i <= n; i++) {
    const alumno_id = idAlumno(i);
    const plan = rng() < 0.7 ? cat.planes[0] : cat.planes[1]; // 70% Informática, 30% Sistemas
    const grafo = grafos.get(plan.plan_id);
    estudiantes.push({
      alumno_id, numero_legajo: `LEG-${String(i).padStart(6, '0')}`,
      nombre: pick(rng, NOMBRES), apellido: pick(rng, APELLIDOS), email: `${alumno_id.toLowerCase()}@alumnos.uade.edu.ar`,
      fecha_nacimiento: `${1998 + Math.floor(rng() * 8)}-${String(1 + Math.floor(rng() * 12)).padStart(2, '0')}-15`,
      fecha_ingreso: '2023-03-01',
      planes: [{ plan_id: plan.plan_id, carrera_id: plan.carrera_id }],
    });
    const aprobadas = new Set(); const regulares = new Set();
    const inicio = Math.floor(rng() * CUATRIMESTRES_PASADOS.length); // algunos alumnos ingresaron más tarde

    // Simula UNA cursada: inscripción + parcial 1 + parcial 2 + (70%) final.
    const cursar = (cuat, materia, conNotas) => {
      // Elige una comisión no llena (de la 5 en adelante: las 1 a 4 son de demo).
      const comision_id = barajar(rng, Array.from({ length: COMISIONES_POR_CUAT - 4 }, (_, k) => k + 5))
        .map((k) => idComision(materia, cuat, k)).find((c) => !llena(c));
      if (!comision_id) return;
      const docente_id = cat.comisiones.get(materia).find((c) => c.comision_id === comision_id).docente_ids[0];
      const f0 = fechaCuat(cuat, Math.floor(rng() * 7));
      inscripciones.push({ alumno_id, fecha_inscripcion: f0, materia_id: materia, comision_id, docente_id, cuatrimestre_id: cuat });
      ocupar(comision_id, alumno_id);
      if (!conNotas) return;
      const p1 = nota(rng, 0.2);
      calificaciones.push({ alumno_id, fecha_evaluacion: fechaCuat(cuat, 45 + Math.floor(rng() * 3)), materia_id: materia, comision_id, mesa_id: null, docente_id, tipo: 'parcial', nota: p1, estado: estadoSegunTipo('parcial', p1) });
      if (p1 < 4) return; // libre: la recursará más adelante
      const p2 = nota(rng, 0.1);
      calificaciones.push({ alumno_id, fecha_evaluacion: fechaCuat(cuat, 90 + Math.floor(rng() * 3)), materia_id: materia, comision_id, mesa_id: null, docente_id, tipo: 'parcial', nota: p2, estado: estadoSegunTipo('parcial', p2) });
      if (p2 < 4) return;
      regulares.add(materia);
      if (rng() < 0.7) { // el 70% rinde el final
        const nf = nota(rng, 0.15);
        calificaciones.push({ alumno_id, fecha_evaluacion: fechaCuat(cuat, 120 + Math.floor(rng() * 5)), materia_id: materia, comision_id, mesa_id: idMesa(materia, `${cuat.slice(0, 4)}-12-10`), docente_id, tipo: 'final', nota: nf, estado: estadoSegunTipo('final', nf) });
        if (nf >= 4) { aprobadas.add(materia); regulares.delete(materia); }
      }
    };

    // Recorre los cuatrimestres pasados: en cada uno cursa 2 a 4 materias que PUEDE cursar.
    for (const cuat of CUATRIMESTRES_PASADOS.slice(inicio)) {
      const k = 2 + Math.floor(rng() * 3);
      barajar(rng, cursablesJS(grafo, plan.materias, aprobadas, regulares)).slice(0, k).forEach((m) => cursar(cuat, m, true));
    }
    if (rng() < 0.45) { // el 45% está cursando en el cuatrimestre actual, sin notas todavía
      const k = 1 + Math.floor(rng() * 3);
      barajar(rng, cursablesJS(grafo, plan.materias, aprobadas, regulares)).slice(0, k).forEach((m) => cursar(CUAT_ACTUAL, m, false));
    }
  }
  return { estudiantes, inscripciones, calificaciones, ocupacion };
}