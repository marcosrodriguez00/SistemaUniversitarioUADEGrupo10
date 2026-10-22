import { connect } from '../db/neo4j.js';

// Modelo del grafo:
//   (:Plan {plan_id}) -[:INCLUYE]-> (:Materia {materia_id})
//   (:Materia)-[:REQUIERE {plan_id, tipo: 'regularizada'|'aprobada'}]->(:Materia)   (materia -> su prerrequisito)
// La materia es global; la correlatividad pertenece a un plan (propiedad plan_id de la relación).
export async function initNeo4j() {
  const driver = await connect();
  const session = driver.session();
  try {
    // Unicidad (y de paso índice) por id. IF NOT EXISTS: se puede correr cuantas veces haga falta.
    await session.run('CREATE CONSTRAINT materia_id IF NOT EXISTS FOR (m:Materia) REQUIRE m.materia_id IS UNIQUE');
    await session.run('CREATE CONSTRAINT plan_id IF NOT EXISTS FOR (p:Plan) REQUIRE p.plan_id IS UNIQUE');
    // Índice sobre la propiedad plan_id de la RELACIÓN: acelera las consultas por plan.
    await session.run('CREATE INDEX requiere_plan IF NOT EXISTS FOR ()-[r:REQUIERE]-() ON (r.plan_id)');
    console.log('✔ Neo4j: constraints e índices listos');
  } finally {
    await session.close();
  }
}