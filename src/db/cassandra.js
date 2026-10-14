import 'dotenv/config';
import cassandra from 'cassandra-driver';

let client;

// Se conecta sin keyspace: las consultas usan nombres completos (universidad.tabla).
// Así el mismo cliente sirve para crear el keyspace en init.
export async function connect() {
  if (!client) {
    client = new cassandra.Client({
      contactPoints: [process.env.CASSANDRA_HOST],
      localDataCenter: process.env.CASSANDRA_DC,
    });
    await client.connect();
  }
  return client;
}

export async function close() {
  if (client) { await client.shutdown(); client = null; }
}