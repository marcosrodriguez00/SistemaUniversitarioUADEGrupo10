// NEO4J: red de correlatividades. Se recorre por adyacencia (cada salto es O(1)).
//   (:Plan)-[:INCLUYE]->(:Materia)
//   (:Materia)-[:REQUIERE {plan_id, tipo}]->(:Materia)
// La materia es un nodo GLOBAL; el plan_id vive en la RELACIÓN, así una materia puede estar
// en varios planes con correlatividades distintas.

export function crearNeo4jRepo(driver) {
  // Abre una sesión, ejecuta la consulta y SIEMPRE la cierra (aunque falle).
  async function run(cypher, params = {}) {
    const session = driver.session();
    try {
      return (await session.run(cypher, params)).records;
    } finally {
      await session.close();
    }
  }
  // Neo4j devuelve enteros propios (Integer); se convierten a número de JS.
  const toNum = (v) => (v && typeof v.toNumber === 'function' ? v.toNumber() : v);

  return {
    // P1: crea el plan, las materias y los vínculos INCLUYE. MERGE = "crear si no existe":
    // se puede repetir sin duplicar nodos ni relaciones (por eso P1 no necesita compensar).
    async asegurarPlanYMaterias(plan_id, materia_ids) {
      await run(
        `MERGE (p:Plan {plan_id: $plan_id})
         WITH p UNWIND $ids AS mid
         MERGE (m:Materia {materia_id: mid})
         MERGE (p)-[:INCLUYE]->(m)`,
        { plan_id, ids: materia_ids },
      );
    },

    // P1: carga un lote de correlatividades [{ materia, requiere, tipo }].
    // Si alguna no se pudo crear (nodo inexistente), lanza error: la saga lo detecta.
    async cargarCorrelatividades(plan_id, lista) {
      const rec = await run(
        `UNWIND $lista AS c
         MATCH (a:Materia {materia_id: c.materia}), (b:Materia {materia_id: c.requiere})
         MERGE (a)-[r:REQUIERE {plan_id: $plan_id}]->(b)
         SET r.tipo = c.tipo
         RETURN count(r) AS n`,
        { plan_id, lista },
      );
      const n = toNum(rec[0].get('n'));
      if (n !== lista.length) throw new Error(`Neo4j cargó ${n} de ${lista.length} correlatividades`);
    },

    // P2 / P5: requisitos directos de una materia EN UN PLAN: [{ requiere, tipo }].
    async requisitos(plan_id, materia_id) {
      const rec = await run(
        `MATCH (:Materia {materia_id: $materia_id})-[r:REQUIERE {plan_id: $plan_id}]->(req:Materia)
         RETURN req.materia_id AS requiere, r.tipo AS tipo ORDER BY requiere`,
        { plan_id, materia_id },
      );
      return rec.map((r) => ({ requiere: r.get('requiere'), tipo: r.get('tipo') }));
    },

    // P7b / P8: materias que se destraban, directa o indirectamente, al aprobar `materia_id`.
    // `*1..15` = recorrido de 1 a 15 saltos hacia atrás por REQUIERE (transitividad).
    async dependientes(plan_id, materia_id) {
      const rec = await run(
        `MATCH (d:Materia)-[:REQUIERE*1..15 {plan_id: $plan_id}]->(:Materia {materia_id: $materia_id})
         RETURN DISTINCT d.materia_id AS id ORDER BY id`,
        { plan_id, materia_id },
      );
      return rec.map((r) => r.get('id'));
    },

    // P7a: materias del plan que el alumno puede cursar: no están aprobadas ni regulares y
    // TODOS sus requisitos se cumplen.
    //   tipo 'aprobada'      → el requisito debe estar aprobado
    //   tipo 'regularizada'  → alcanza con regular o aprobado
    // Las materias sin requisitos salen solas (lista vacía → ALL(...) es verdadero).
    async cursables(plan_id, aprobadas, regulares) {
      const rec = await run(
        `MATCH (:Plan {plan_id: $plan_id})-[:INCLUYE]->(m:Materia)
         WHERE NOT m.materia_id IN $excluidas
         OPTIONAL MATCH (m)-[r:REQUIERE {plan_id: $plan_id}]->(req:Materia)
         WITH m, collect({id: req.materia_id, tipo: r.tipo}) AS reqs
         WHERE ALL(x IN reqs WHERE x.id IS NULL
                   OR (x.tipo = 'aprobada' AND x.id IN $aprobadas)
                   OR (x.tipo <> 'aprobada' AND x.id IN $habilitantes))
         RETURN m.materia_id AS id ORDER BY id`,
        {
          plan_id,
          aprobadas,
          habilitantes: [...aprobadas, ...regulares],
          excluidas: [...aprobadas, ...regulares],
        },
      );
      return rec.map((r) => r.get('id'));
    },

    // P7c: cadena de correlatividades más larga, de prerrequisito a materia final.
    // Ordena todos los caminos por longitud y toma el primero.
    async cadenaMasLarga(plan_id) {
      const rec = await run(
        `MATCH path = (:Materia)-[:REQUIERE*1..15 {plan_id: $plan_id}]->(:Materia)
         RETURN reverse([n IN nodes(path) | n.materia_id]) AS cadena
         ORDER BY length(path) DESC LIMIT 1`,
        { plan_id },
      );
      return rec.length ? rec[0].get('cadena') : [];
    },
  };
}