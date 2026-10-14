import * as mongo from '../src/db/mongo.js';
import * as redis from '../src/db/redis.js';
import * as neo4j from '../src/db/neo4j.js';
import * as cassandra from '../src/db/cassandra.js';

const checks = [
  ['MongoDB', mongo, async () => (await mongo.connect()).command({ ping: 1 })],
  ['Redis', redis, async () => (await redis.connect()).ping()],
  ['Neo4j', neo4j, async () => {
    const s = (await neo4j.connect()).session();
    try { await s.run('RETURN 1'); } finally { await s.close(); }
  }],
  ['Cassandra', cassandra, async () => (await cassandra.connect()).execute('SELECT now() FROM system.local')],
];

let fallos = 0;
for (const [nombre, modulo, ping] of checks) {
  try {
    await ping();
    console.log(`✔ ${nombre}: OK`);
  } catch (e) {
    fallos++;
    console.log(`✘ ${nombre}: FALLÓ → ${e.message}`);
  } finally {
    await modulo.close().catch(() => {});
  }
}
process.exit(fallos ? 1 : 0);