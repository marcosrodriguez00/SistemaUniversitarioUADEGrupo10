// CLI: capa de PRESENTACIÓN. Cada problema y cada escenario de falla se ejecuta desde acá.
//   node src/cli.js                   -> menú interactivo (elige alumnos, materias y comisiones de listas)
//   node src/cli.js p2 --alumno A-DEMO-01 --comision COM-015-2026-2-1
//   node src/cli.js p2 --alumno A-DEMO-01 --comision COM-015-2026-2-1 --fail-at registrar-inscripcion
// No tiene lógica de negocio: traduce argumentos a llamadas a los problemas e imprime la evidencia.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { crearContexto, cerrarContexto } from './contexto.js';
import { conFailpoints } from './saga/failpoints.js';
import { recuperar } from './saga/runner.js';
import {
  p1CargarPlan, p2Inscribir, p3CambiarComision, p4CargarCalificaciones, p5InscribirMesa,
  p6Trayectoria, p7PuedoCursar, p7Destraba, p7CadenaMasLarga, p8Rectificar, p8Trazabilidad, SAGAS,
} from './problemas/index.js';
import { generarCatalogo, elegirDemo } from './seed/generador.js';
import { pedirParametro } from './seleccion.js';

// Ids de demo: se calculan con la MISMA semilla (42) que el seed, así coinciden con los datos cargados.
// Se usan solo como VALORES POR DEFECTO: cualquier id válido se puede ingresar a mano.
const DEMO = elegirDemo(generarCatalogo(42));
// Imprime JSON legible (convierte los BigInt de Cassandra a número).
const imprimir = (x) => console.log(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));

// ---- EVIDENCIA antes/después (sección 6 del informe): una "foto" del estado de un cupo en
// Redis y en Cassandra. Permite mostrar que tras una falla compensada AMBOS quedan como antes.
async function fotoCupo(ctx, ns, id, alumno_id) {
  const [disponible, reservas, insc] = await Promise.all([
    ctx.redis.disponible(ns, id),
    ctx.redis.reservas(ns, id),
    ns === 'comision' ? ctx.cass.inscripcionesComision(id) : ctx.cass.inscripcionesMesaMesa(id),
  ]);
  return { [`${ns}`]: id, redis_disponible: disponible, redis_reservado_por_alumno: reservas.includes(alumno_id), cassandra_inscriptos: insc.length, cassandra_alumno_inscripto: insc.some((r) => r.alumno_id === alumno_id) };
}
// Saca la foto ANTES, ejecuta la operación, saca la foto DESPUÉS, y agrega el saga_log de esa operación.
async function conEvidencia(ctx, fotos, fn) {
  const antes = await Promise.all(fotos.map((f) => fotoCupo(ctx, ...f)));
  const resultado = await fn();
  const despues = await Promise.all(fotos.map((f) => fotoCupo(ctx, ...f)));
  const log = await ctx.log.get(resultado.operacion_id);
  imprimir({ resultado, evidencia: { antes, despues }, saga_log: log && { estado: log.estado, pasos_iniciados: log.pasos_iniciados, pasos_completados: log.pasos_completados, compensaciones: log.compensaciones } });
  return resultado;
}

// "A-DEMO-11:7,A-DEMO-14:3" -> [{alumno_id, nota}, ...] (formato del parámetro --notas de P4)
const parseNotas = (s) => s.split(',').map((p) => { const [alumno_id, nota] = p.split(':'); return { alumno_id: alumno_id.trim(), nota: Number(nota) }; });

// TABLA DE COMANDOS: cada entrada tiene desc (descripción), params ([nombre, valor por defecto])
// y run (qué ejecuta). Los valores por defecto son los alumnos y comisiones de demo del seed.
export const COMANDOS = {
  p1: {
    desc: 'P1 Carga de un plan de estudios',
    fallas: [['correlatividad-medio', 'Falla a mitad de la carga de correlatividades'], ['habilitar', 'Falla al habilitar el plan (último paso)']],
    params: [['archivo', 'src/seed/plan-ejemplo.json']],
    run: async (ctx, a) => {
      const input = JSON.parse(fs.readFileSync(a.archivo, 'utf8'));
      const r = await p1CargarPlan(ctx, input);
      const plan = await ctx.mongo.getPlan(input.plan_id);
      const log = await ctx.log.get(r.operacion_id);
      imprimir({ resultado: r, plan_en_mongo: plan && { estado: plan.estado, materias: plan.materias.length }, saga_log: { estado: log.estado, pasos_completados: log.pasos_completados, compensaciones: log.compensaciones } });
    },
  },
  p2: {
    desc: 'P2 Inscripción a cursada',
    fallas: [['reservar-cupo', 'Falla justo después de reservar el cupo en Redis'], ['registrar-inscripcion', 'Falla después de grabar en Cassandra (se deshace todo)']],
    params: [['alumno', DEMO.alumnos.elegible], ['comision', DEMO.comisiones.llena_casi]],
    // `a.operacion` permite REINTENTAR la misma operación (--operacion OP-...): demuestra idempotencia.
    run: (ctx, a) => conEvidencia(ctx, [['comision', a.comision, a.alumno]], () => p2Inscribir(ctx, { alumno_id: a.alumno, comision_id: a.comision }, a.operacion && { operacion_id: a.operacion })),
  },
  p3: {
    desc: 'P3 Cambio de comisión',
    fallas: [['reservar-destino', 'Falla después de reservar el lugar en la comisión destino'], ['liberar-origen', 'Falla después de liberar el lugar en el origen'], ['mover-inscripcion', 'Falla después de mover la inscripción en Cassandra']],
    params: [['alumno', DEMO.alumnos.cambia], ['origen', DEMO.comisiones.origen], ['destino', DEMO.comisiones.vacia]],
    // Evidencia de las DOS comisiones: origen y destino.
    run: (ctx, a) => conEvidencia(ctx, [['comision', a.origen, a.alumno], ['comision', a.destino, a.alumno]], () => p3CambiarComision(ctx, { alumno_id: a.alumno, comision_origen: a.origen, comision_destino: a.destino })),
  },
  p4: {
    desc: 'P4 Carga de calificaciones (parcial por comisión / final por mesa)',
    params: [['tipo', 'parcial'], ['comision', DEMO.comisiones.origen], ['mesa', ''], ['docente', 'D0001'], ['notas', `${DEMO.alumnos.cambia}:7,${DEMO.alumnos.para_rectificar}:3`]],
    run: async (ctx, a) => imprimir(await p4CargarCalificaciones(ctx, { docente_id: a.docente, tipo: a.tipo, comision_id: a.comision || undefined, mesa_id: a.mesa || undefined, notas: parseNotas(a.notas) })),
  },
  p5: {
    desc: 'P5 Inscripción a mesa de final',
    fallas: [['reservar-cupo', 'Falla justo después de reservar el cupo de la mesa'], ['registrar-inscripcion', 'Falla después de grabar en Cassandra (se deshace todo)']],
    params: [['alumno', DEMO.alumnos.para_mesa], ['mesa', DEMO.mesa]],
    run: (ctx, a) => conEvidencia(ctx, [['mesa', a.mesa, a.alumno]], () => p5InscribirMesa(ctx, { alumno_id: a.alumno, mesa_id: a.mesa })),
  },
  p6: { desc: 'P6 Trayectoria académica', params: [['alumno', DEMO.alumnos.elegible]], run: async (ctx, a) => imprimir(await p6Trayectoria(ctx, { alumno_id: a.alumno })) },
  p7: {
    desc: 'P7 Qué puedo cursar (alumno) / qué destrabo (materia) / cadena más larga',
    params: [['alumno', DEMO.alumnos.elegible], ['materia', ''], ['plan', DEMO.plan_id], ['cadena', '']],
    run: async (ctx, a) => {
      if (a.cadena) return imprimir(await p7CadenaMasLarga(ctx, { plan_id: a.plan }));                   // 7c
      if (a.materia) return imprimir(await p7Destraba(ctx, { materia_id: a.materia, plan_id: a.plan })); // 7b
      return imprimir(await p7PuedoCursar(ctx, { alumno_id: a.alumno, plan_id: a.plan }));                // 7a
    },
  },
  p8: {
    desc: 'P8 Rectificar nota (o consulta de trazabilidad)',
    fallas: [['rectificar', 'Falla después de corregir la nota'], ['marcado-medio', 'Falla a mitad del marcado de inscripciones en revisión']],
    params: [['alumno', DEMO.alumnos.para_rectificar], ['materia', DEMO.prerrequisito], ['nota', '2'], ['trazabilidad', '']],
    run: async (ctx, a) => {
      if (a.trazabilidad) return imprimir(await p8Trazabilidad(ctx, { alumno_id: a.alumno }));
      // Foto del alumno ANTES y DESPUÉS de rectificar, para mostrar qué cambió.
      const antes = await p8Trazabilidad(ctx, { alumno_id: a.alumno });
      const r = await p8Rectificar(ctx, { alumno_id: a.alumno, materia_id: a.materia, nueva_nota: Number(a.nota) });
      const despues = await p8Trazabilidad(ctx, { alumno_id: a.alumno });
      const resumen = (t) => ({ inscripciones_activas: t.inscripciones_activas, materias_aprobadas: t.trayectoria.materias_aprobadas, finales: t.trayectoria.finales_rendidos.filter((f) => f.materia_id === a.materia).map((f) => ({ nota: f.nota, estado: f.estado })) });
      const log = await ctx.log.get(r.operacion_id);
      imprimir({ resultado: r, evidencia: { antes: resumen(antes), despues: resumen(despues) }, saga_log: { estado: log.estado, pasos_completados: log.pasos_completados, compensaciones: log.compensaciones } });
    },
  },
  'estado-cupo': {
    desc: 'Compara el contador de Redis con las filas de Cassandra (evidencia de consistencia)',
    params: [['comision', DEMO.comisiones.llena_casi], ['mesa', '']],
    run: async (ctx, a) => {
      const [ns, id] = a.mesa ? ['mesa', a.mesa] : ['comision', a.comision];
      const [disp, insc] = await Promise.all([ctx.redis.disponible(ns, id), ns === 'mesa' ? ctx.cass.inscripcionesMesaMesa(id) : ctx.cass.inscripcionesComision(id)]);
      const ent = ns === 'mesa' ? await ctx.mongo.getMesa(id) : await ctx.mongo.getComision(id);
      // Consistente = lo que dice Redis coincide con cupo_maximo (Mongo) - inscriptos (Cassandra).
      imprimir({ [ns]: id, cupo_maximo_mongo: ent.cupo_maximo, redis_disponible: disp, cassandra_inscriptos: insc.length, consistente: disp === ent.cupo_maximo - insc.length });
    },
  },
  operacion: {
    desc: 'Muestra el saga_log de una operación',
    params: [['operacion', '']],
    run: async (ctx, a) => imprimir(await ctx.log.get(a.operacion)),
  },
  recuperar: {
    desc: 'Deshace las sagas que quedaron a medias tras una caída',
    params: [],
    // antiguedadMs: 0 = recupera todas las pendientes, sin esperar (útil en la demo).
    run: async (ctx) => imprimir(await recuperar(ctx, SAGAS, { antiguedadMs: 0 })),
  },
  concurrencia: {
    desc: 'N alumnos compiten por el mismo cupo en paralelo (el cupo nunca se sobrepasa)',
    params: [['n', '10'], ['comision', DEMO.comisiones.llena_casi]],
    run: async (ctx, a) => {
      const n = Number(a.n);
      const alumnos = Array.from({ length: n }, (_, i) => `A-DEMO-${String(i + 1).padStart(2, '0')}`);
      const antes = await fotoCupo(ctx, 'comision', a.comision, '');
      // Promise.all lanza las N inscripciones A LA VEZ. El script Lua de Redis las serializa.
      const rs = await Promise.all(alumnos.map((alumno_id) => p2Inscribir(ctx, { alumno_id, comision_id: a.comision })));
      const despues = await fotoCupo(ctx, 'comision', a.comision, '');
      imprimir({ intentos: n, inscriptos_ok: rs.filter((r) => r.ok).length, rechazados: rs.filter((r) => !r.ok).map((r) => ({ estado: r.estado, codigo: r.error?.codigo })), antes, despues });
    },
  },
  demo: { desc: 'Muestra los ids de demo del seed', params: [], run: async () => imprimir(DEMO), sinMotores: true },
};

// Muestra "1. Sin falla" + las fallas disponibles de la saga y devuelve el paso elegido (o null).
async function elegirFalla(rl, fallas) {
  console.log('  Ejecución:');
  console.log('    1. Normal (sin falla)');
  fallas.forEach(([paso, desc], i) => console.log(`    ${i + 2}. Provocar falla — ${desc}  [${paso}]`));
  for (;;) {
    const r = (await rl.question('  Número (Enter = 1, normal): ')).trim();
    if (r === '' || r === '1') return null;
    const f = fallas[Number(r) - 2];
    if (f) return f[0];
    console.log(`  Número inválido: elegí entre 1 y ${fallas.length + 1}.`);
  }
}

// MENÚ INTERACTIVO: lista los comandos, pide cada parámetro (con selector de alumno, materia,
// comisión o mesa; ver seleccion.js) y pregunta en qué paso provocar una falla (solo en las sagas).
async function menu(ctx) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const nombres = Object.keys(COMANDOS);
  try {
    for (;;) {
      console.log('\n=== Sistema de gestión universitaria ===');
      nombres.forEach((n, i) => console.log(`${String(i + 1).padStart(2)}. ${n.padEnd(12)} ${COMANDOS[n].desc}`));
      console.log(' 0. salir');
      const op = (await rl.question('Opción: ')).trim();
      if (op === '0' || op === '') break;
      const nombre = nombres[Number(op) - 1] ?? (COMANDOS[op] ? op : null);
      if (!nombre) { console.log('Opción inválida'); continue; }
      const cmd = COMANDOS[nombre];
      const a = {};
      const estado = {}; // recuerda la materia elegida mientras dura este comando
      for (const [k, def] of cmd.params) a[k] = await pedirParametro(rl, ctx, k, def, estado);
      // Selector de falla: solo para las sagas (comandos con `fallas`). La opción 1 siempre es "sin falla".
      let failAt = null;
      if (cmd.fallas && !a.trazabilidad) failAt = await elegirFalla(rl, cmd.fallas);
      conFailpoints(ctx, failAt);
      try { await cmd.run(ctx, a); } catch (e) { console.error('✘', e.message); }
    }
  } finally { rl.close(); }
}

// PUNTO DE ENTRADA: lee el comando y los argumentos, conecta los motores y ejecuta.
async function main() {
  const [nombre, ...resto] = process.argv.slice(2);
  if (nombre === 'demo') return imprimir(DEMO); // no necesita conectar los motores
  if (nombre && !COMANDOS[nombre] && nombre !== 'menu') { console.error(`Comando desconocido: ${nombre}\nDisponibles: ${Object.keys(COMANDOS).join(', ')}`); process.exitCode = 1; return; }
  // Opciones conocidas: las banderas (sin valor) son booleanas y TODO parámetro de cada comando
  // se declara como string. Si no se declaran, parseArgs trata "--alumno A-DEMO-02" como una
  // bandera sin valor y el id queda suelto.
  const options = { 'fail-at': { type: 'string' }, operacion: { type: 'string' }, cadena: { type: 'boolean' }, trazabilidad: { type: 'boolean' } };
  for (const cmd of Object.values(COMANDOS)) for (const [k] of cmd.params) if (!(k in options)) options[k] = { type: 'string' };
  const { values } = parseArgs({ args: resto, strict: false, options });
  const ctx = await crearContexto({ failAt: values['fail-at'] ?? null }); // --fail-at activa el failpoint
  try {
    if (!nombre || nombre === 'menu') return await menu(ctx);
    const cmd = COMANDOS[nombre];
    const a = {};
    for (const [k, def] of cmd.params) {
      const v = values[k];
      a[k] = v === true ? 'true' : v ?? def; // bandera sin valor -> 'true'; sin parámetro -> valor por defecto
    }
    if (values.operacion) a.operacion = values.operacion; // reintento de una operación existente
    await cmd.run(ctx, a);
  } finally {
    await cerrarContexto();
  }
}

// Solo corre si se ejecuta directamente (no al importarlo).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('✘', e.message); process.exitCode = 1; });
}