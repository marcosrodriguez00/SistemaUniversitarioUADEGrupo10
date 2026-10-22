// CARGA DE DATOS DE PRUEBA: reproducible (semillas fijas) y ejecutable desde cero.
// OJO: BORRA todo el contenido de los 4 motores antes de cargar. Uso: npm run seed
import { pathToFileURL } from 'node:url';
import { crearContexto, cerrarContexto } from '../contexto.js';
import { initTodo } from '../init/init.js';
import { KEYSPACE } from '../config.js';
import {
  generarCatalogo, simularEstudiantes, elegirDemo, generarDemo, CUAT_ACTUAL, CUAT_SIGUIENTE,
} from './generador.js';

const T = (n) => `${KEYSPACE}.${n}`;
// Parte un arreglo en lotes de tamaño n (para no mandar millones de filas de una vez).
const lotes = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));

// Vacía los 4 motores. TRUNCATE en Cassandra, deleteMany en Mongo, DETACH DELETE en Neo4j, FLUSHDB en Redis.
async function reset(ctx) {
  await Promise.all(['inscripciones_por_alumno', 'inscripciones_por_comision', 'calificaciones_por_alumno', 'inscripciones_mesa_por_alumno', 'inscripciones_mesa_por_mesa']
    .map((t) => ctx.raw.cassandra.execute(`TRUNCATE ${T(t)}`)));
  for (const c of ['planes', 'materias', 'docentes', 'estudiantes', 'mesas', 'saga_log']) await ctx.raw.db.collection(c).deleteMany({});
  const s = ctx.raw.neo4j.session();
  try { await s.run('MATCH (n) DETACH DELETE n'); } finally { await s.close(); }
  await ctx.raw.redis.flushdb();
}

export async function seed({ estudiantes = Number(process.env.SEED_ESTUDIANTES ?? 5000) } = {}) {
  const t0 = Date.now();
  await initTodo();                 // crea esquemas e índices (idempotente)
  const ctx = await crearContexto();
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  try {
    log('Reiniciando los 4 motores...');
    await reset(ctx);

    // ---------- 1. GENERAR todo en memoria (con semillas fijas: siempre sale lo mismo)
    const cat = generarCatalogo(42);                       // planes, materias, comisiones, docentes, mesas
    const demo = elegirDemo(cat);                          // ids fijos para la demostración
    const bulk = simularEstudiantes(cat, estudiantes, 7);  // miles de estudiantes con historial
    const dm = generarDemo(cat, demo);                     // alumnos de demo con casos armados a propósito
    const todosEst = [...bulk.estudiantes, ...dm.estudiantes];
    const inscripciones = [...bulk.inscripciones, ...dm.inscripciones];
    const calificaciones = [...bulk.calificaciones, ...dm.calificaciones];
    const ocupacion = new Map([...bulk.ocupacion, ...dm.ocupacion]); // quién ocupa cada comisión

    // ---------- 2. MONGODB: catálogo
    const db = ctx.raw.db;
    await db.collection('planes').insertMany(cat.planes.map((p) => ({ _id: p.plan_id, plan_id: p.plan_id, nombre: p.nombre, carrera_id: p.carrera_id, materias: p.materias, estado: 'habilitado' })));
    await db.collection('materias').insertMany(cat.materias.map((m) => ({ _id: m.materia_id, ...m, comisiones: cat.comisiones.get(m.materia_id) })));
    await db.collection('docentes').insertMany(cat.docentes.map((d) => ({ _id: d.docente_id, ...d })));
    await db.collection('mesas').insertMany(cat.mesas.map((m) => ({ _id: m.mesa_id, ...m, fecha: new Date(`${m.fecha}T12:00:00Z`) })));
    for (const l of lotes(todosEst, 1000)) {
      await db.collection('estudiantes').insertMany(l.map((e) => ({ _id: e.alumno_id, ...e })), { ordered: false });
    }
    log(`Mongo: ${cat.planes.length} planes, ${cat.materias.length} materias, ${cat.docentes.length} docentes, ${cat.mesas.length} mesas, ${todosEst.length} estudiantes`);

    // ---------- 3. NEO4J: grafo (usa las MISMAS funciones del repo que P1)
    let nCorr = 0;
    for (const p of cat.planes) {
      await ctx.neo4j.asegurarPlanYMaterias(p.plan_id, p.materias);
      for (const l of lotes(p.correlatividades, 100)) await ctx.neo4j.cargarCorrelatividades(p.plan_id, l);
      nCorr += p.correlatividades.length;
    }
    log(`Neo4j: ${cat.materias.length} materias, ${nCorr} correlatividades (por plan)`);

    // ---------- 4. CASSANDRA: todas las filas en una lista y se escriben en concurrencia
    const s = ctx.cass.sql;
    const q = [];
    for (const i of inscripciones) {   // cada inscripción va a las DOS tablas (denormalización)
      q.push({ query: s.insAlumno, params: [i.alumno_id, i.fecha_inscripcion, i.materia_id, i.comision_id, i.docente_id, i.cuatrimestre_id, false] });
      q.push({ query: s.insCom, params: [i.comision_id, i.fecha_inscripcion, i.alumno_id, i.materia_id, i.docente_id, i.cuatrimestre_id] });
    }
    for (const c of calificaciones) {  // la entidad de mayor volumen (≥ 50.000 filas)
      q.push({ query: s.calif, params: [c.alumno_id, c.fecha_evaluacion, c.materia_id, c.comision_id, c.mesa_id ?? null, c.docente_id, c.tipo, c.nota, c.estado] });
    }
    for (const m of dm.mesaInsc) {
      q.push({ query: `INSERT INTO ${T('inscripciones_mesa_por_alumno')} (alumno_id, fecha_mesa, materia_id, mesa_id) VALUES (?,?,?,?)`, params: [m.alumno_id, m.fecha_mesa, m.materia_id, m.mesa_id] });
      q.push({ query: `INSERT INTO ${T('inscripciones_mesa_por_mesa')} (mesa_id, alumno_id, materia_id) VALUES (?,?,?)`, params: [m.mesa_id, m.alumno_id, m.materia_id] });
    }
    for (const l of lotes(q, 20000)) { await ctx.cass.ejecutarConcurrente(l); log(`Cassandra: ${l.length} filas escritas`); }

    // ---------- 5. REDIS: contadores de cupo = cupo_maximo - ocupantes (la misma fórmula de reconstruirCupo)
    let nCupos = 0;
    for (const [, lista] of cat.comisiones) {
      for (const c of lista) {
        if (c.cuatrimestre_id !== CUAT_ACTUAL && c.cuatrimestre_id !== CUAT_SIGUIENTE) continue; // solo cuatrimestres con inscripción abierta
        const ocupantes = [...(ocupacion.get(c.comision_id) ?? [])];
        await ctx.redis.inicializar('comision', c.comision_id, c.cupo_maximo - ocupantes.length, ocupantes);
        nCupos++;
      }
    }
    for (const m of cat.mesas) {
      const ocupantes = [...(dm.ocupacionMesa.get(m.mesa_id) ?? [])];
      await ctx.redis.inicializar('mesa', m.mesa_id, m.cupo_maximo - ocupantes.length, ocupantes);
      nCupos++;
    }
    log(`Redis: ${nCupos} contadores de cupo`);

    const resumen = {
      calificaciones_por_alumno: calificaciones.length,
      inscripciones_por_alumno: inscripciones.length,
      inscripciones_por_comision: inscripciones.length,
      estudiantes: todosEst.length,
    };
    console.log('\nVolumen cargado:', resumen);
    if (calificaciones.length < 50000) console.warn('⚠ Menos de 50.000 registros en la entidad de mayor volumen: subí SEED_ESTUDIANTES');
    console.log('\nDatos de demo (ids fijos):', JSON.stringify(demo, null, 2));
    log('Seed completo.');
    return { resumen, demo };
  } finally {
    await cerrarContexto();
  }
}

// Se ejecuta solo si se corre directamente (npm run seed).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().catch((e) => { console.error('✘ Seed falló:', e); process.exitCode = 1; });
}