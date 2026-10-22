import { CUATRIMESTRE_ACTUAL } from './config.js';

// SELECTORES DEL MENÚ INTERACTIVO. Capa de presentación: no tiene lógica de negocio.
// Para no obligar a escribir ids de memoria, cada parámetro conocido (alumno, materia,
// comisión, mesa) se puede elegir buscando por nombre y marcando un número de la lista.
// Si el usuario no elige nada, se vuelve al comportamiento de siempre: escribir el id a mano.

// Muestra una lista numerada y devuelve el valor elegido. Si el número no es válido, avisa y
// vuelve a preguntar; con Enter devuelve null (el llamador pide el id a mano).
async function elegir(rl, titulo, opciones) {
  if (!opciones.length) { console.log('  (sin resultados)'); return null; }
  console.log(`  ${titulo}`);
  opciones.forEach((o, i) => console.log(`   ${String(i + 1).padStart(2)}. ${o.etiqueta}`));
  for (;;) {
    const r = (await rl.question('  Número (Enter = escribir el id a mano): ')).trim();
    if (!r) return null;
    const n = Number(r);
    if (Number.isInteger(n) && n >= 1 && n <= opciones.length) return opciones[n - 1].valor;
    console.log(`  Número inválido: elegí entre 1 y ${opciones.length}.`);
  }
}

// Alumno: se busca en Mongo por nombre, apellido o id.
async function elegirAlumno(rl, ctx, def) {
  const txt = (await rl.question(`  alumno: buscar por nombre, apellido o id (Enter = ${def}): `)).trim();
  if (!txt) return def;
  const lista = await ctx.mongo.buscarEstudiantes(txt, 10);
  const v = await elegir(rl, 'Alumnos encontrados:', lista.map((e) => ({ etiqueta: `${e.nombre} ${e.apellido}  (${e._id})`, valor: e._id })));
  return v ?? txt; // si no eligió de la lista, se toma lo escrito como id
}

// Materia: se busca en Mongo por nombre o código. Se guarda en `estado` para reutilizarla
// al elegir comisión u origen/destino del mismo comando.
async function elegirMateria(rl, ctx, estado) {
  if (estado.materia_id) return estado.materia_id;
  const txt = (await rl.question('  materia: buscar por nombre o código (Enter = saltear): ')).trim();
  if (!txt) return null;
  const lista = await ctx.mongo.buscarMaterias(txt, 10);
  const v = await elegir(rl, 'Materias encontradas:', lista.map((m) => ({ etiqueta: `${m.nombre}  (${m._id})`, valor: m._id })));
  if (v) estado.materia_id = v;
  return v;
}

// Comisión: de la materia elegida, las del cuatrimestre actual con su cupo disponible (Redis).
async function elegirComision(rl, ctx, nombre, def, estado) {
  const materia = await elegirMateria(rl, ctx, estado);
  if (!materia) return null;
  const lista = await ctx.mongo.comisionesDeMateria(materia, CUATRIMESTRE_ACTUAL);
  const cupos = await Promise.all(lista.map((c) => ctx.redis.disponible('comision', c.comision_id)));
  return elegir(rl, `Comisiones de ${materia} (${CUATRIMESTRE_ACTUAL}) — para "${nombre}":`,
    lista.map((c, i) => ({
      etiqueta: `${c.comision_id}  cupo disponible: ${cupos[i] ?? '?'}  aula ${c.aula}  ${c.horarios?.map((h) => `${h.dia} ${h.desde}`).join(', ')}`,
      valor: c.comision_id,
    })));
}

// Mesa: de la materia elegida, sus mesas de examen con fecha y cupo disponible.
async function elegirMesa(rl, ctx, estado) {
  const materia = await elegirMateria(rl, ctx, estado);
  if (!materia) return null;
  const lista = await ctx.mongo.mesasDeMateria(materia);
  const cupos = await Promise.all(lista.map((m) => ctx.redis.disponible('mesa', m._id)));
  return elegir(rl, `Mesas de ${materia}:`,
    lista.map((m, i) => ({ etiqueta: `${m._id}  ${new Date(m.fecha).toISOString().slice(0, 10)}  cupo disponible: ${cupos[i] ?? '?'}`, valor: m._id })));
}

// Punto de entrada: pide UN parámetro del comando. `estado` vive mientras dura el comando.
export async function pedirParametro(rl, ctx, nombre, def, estado) {
  let v = null;
  if (nombre === 'alumno') return elegirAlumno(rl, ctx, def);
  if (nombre === 'materia') v = await elegirMateria(rl, ctx, estado);
  else if (['comision', 'origen', 'destino'].includes(nombre)) v = await elegirComision(rl, ctx, nombre, def, estado);
  else if (nombre === 'mesa') v = await elegirMesa(rl, ctx, estado);
  if (v) return v;
  // Sin selección: pregunta clásica (se escribe el id o se acepta el valor por defecto).
  return (await rl.question(`  ${nombre} [${def}]: `)).trim() || def;
}